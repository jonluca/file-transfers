package expo.modules.directtransfernative

import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.OpenableColumns
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.ceil
import kotlin.math.min

private const val HEADER_TERMINATOR = "\r\n\r\n"
private const val HEADER_LIMIT_BYTES = 64 * 1024
private const val IO_PAGE_BYTES = 256 * 1024
private const val PAYLOAD_KEEP_ALIVE_IDLE_TIMEOUT_MS = 5_000
private const val PAYLOAD_KEEP_ALIVE_MAX_REQUESTS = 32L

class DirectTransferNativeModule : Module() {
  private data class PayloadFile(
    val id: String,
    val mimeType: String,
    val sizeBytes: Long,
    val uri: String,
  )

  private data class PayloadSession(
    val filesById: Map<String, PayloadFile>,
    val maxBytesPerSecond: Long?,
    val sessionId: String,
  )

  private data class PayloadMetric(
    val bytesServed: Long,
    val fileId: String,
    val fileReadDurationMs: Double,
    val responseCopyDurationMs: Double,
    val sessionId: String,
    val totalDurationMs: Double,
    val usedNativeServer: Boolean,
  ) {
    fun toMap(): Map<String, Any> {
      return mapOf(
        "sessionId" to sessionId,
        "fileId" to fileId,
        "bytesServed" to bytesServed.toDouble(),
        "fileReadDurationMs" to fileReadDurationMs,
        "responseCopyDurationMs" to responseCopyDurationMs,
        "totalDurationMs" to totalDurationMs,
        "usedNativeServer" to usedNativeServer,
      )
    }
  }

  private inner class PayloadServer {
    @Volatile
    private var serverSocket: ServerSocket? = null
    private val acceptExecutor = Executors.newSingleThreadExecutor()
    private val connectionExecutor = Executors.newCachedThreadPool()

    fun ensureStarted(): Int {
      serverSocket?.let { socket ->
        if (!socket.isClosed) {
          return socket.localPort
        }
      }

      val socket = ServerSocket()
      socket.reuseAddress = true
      socket.bind(InetSocketAddress("0.0.0.0", 0))
      serverSocket = socket
      acceptExecutor.execute {
        while (!socket.isClosed) {
          try {
            val client = socket.accept()
            client.tcpNoDelay = true
            client.keepAlive = true
            client.soTimeout = PAYLOAD_KEEP_ALIVE_IDLE_TIMEOUT_MS
            connectionExecutor.execute {
              handlePayloadConnection(client)
            }
          } catch (_: SocketException) {
            break
          } catch (_: Exception) {
            // Ignore individual accept failures and continue until the socket closes.
          }
        }
      }
      return socket.localPort
    }

    fun stop() {
      serverSocket?.closeQuietly()
      serverSocket = null
    }
  }

  private inner class RangeDownloadTask(
    private val chunkBytes: Int,
    private val destinationUri: String,
    private val headers: Map<String, String>,
    private val maxBytesPerSecond: Long?,
    private val taskId: String,
    private val totalBytes: Long,
    private val url: String,
  ) {
    private val cancelled = AtomicBoolean(false)
    private val progressLock = Any()
    private val startedAtMs = System.currentTimeMillis().toDouble()

    @Volatile
    private var activeConnection: HttpURLConnection? = null
    @Volatile
    private var bytesTransferred = 0L
    @Volatile
    private var requestDurationMs = 0.0
    @Volatile
    private var diskWriteDurationMs = 0.0

    fun cancel() {
      cancelled.set(true)
      runCatching {
        activeConnection?.disconnect()
      }
    }

    fun snapshot(): Map<String, Any> {
      synchronized(progressLock) {
        return mapOf(
          "taskId" to taskId,
          "bytesTransferred" to bytesTransferred.toDouble(),
          "totalBytes" to totalBytes.toDouble(),
          "requestDurationMs" to requestDurationMs,
          "diskWriteDurationMs" to diskWriteDurationMs,
          "startedAtMs" to startedAtMs,
          "usedNative" to true,
        )
      }
    }

    fun run(): Map<String, Any> {
      val outputPath = requireFilePath(destinationUri)
      val outputFile = File(outputPath)
      outputFile.parentFile?.mkdirs()

      RandomAccessFile(outputFile, "rw").use { file ->
        file.setLength(totalBytes)
      }

      val chunkCount = ceil(totalBytes.toDouble() / chunkBytes.toDouble()).toInt()
      RandomAccessFile(outputFile, "rw").use { file ->
        for (currentChunkIndex in 0 until chunkCount) {
          if (cancelled.get()) {
            break
          }

          val start = currentChunkIndex.toLong() * chunkBytes.toLong()
          val end = min(start + chunkBytes - 1L, totalBytes - 1L)
          downloadChunk(file, start, end)
        }
      }

      if (cancelled.get()) {
        throw IllegalStateException("Download canceled.")
      }

      val completedAtMs = System.currentTimeMillis().toDouble()
      synchronized(progressLock) {
        return mapOf(
          "taskId" to taskId,
          "bytesTransferred" to bytesTransferred.toDouble(),
          "totalBytes" to totalBytes.toDouble(),
          "requestDurationMs" to requestDurationMs,
          "diskWriteDurationMs" to diskWriteDurationMs,
          "startedAtMs" to startedAtMs,
          "completedAtMs" to completedAtMs,
          "usedNative" to true,
        )
      }
    }

    private fun downloadChunk(file: RandomAccessFile, start: Long, end: Long) {
      if (cancelled.get()) {
        throw IllegalStateException("Download canceled.")
      }

      val connection = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        instanceFollowRedirects = true
        connectTimeout = 15_000
        readTimeout = 30_000
        setRequestProperty("Range", "bytes=$start-$end")
        headers.forEach { (key, value) ->
          setRequestProperty(key, value)
        }
      }
      activeConnection = connection

      val requestStartedAt = SystemClock.elapsedRealtimeNanos()
      var localDiskWriteDurationMs = 0.0
      var chunkBytesTransferred = 0L

      try {
        val responseCode = connection.responseCode
        if (responseCode != HttpURLConnection.HTTP_PARTIAL) {
          throw IllegalStateException("Unable to download file chunk ($responseCode).")
        }

        val contentRange = parseContentRange(connection.getHeaderField("Content-Range"))
        val expectedChunkBytes = end - start + 1L
        if (
          contentRange == null ||
          contentRange.start != start ||
          contentRange.end != end ||
          (contentRange.total != null && contentRange.total != totalBytes)
        ) {
          throw IllegalStateException("The sender returned an unexpected file chunk.")
        }

        BufferedInputStream(connection.inputStream).use { input ->
          val buffer = ByteArray(IO_PAGE_BYTES)
          var nextOffset = start

          while (!cancelled.get()) {
            val bytesRead = input.read(buffer, 0, min(buffer.size.toLong(), end - nextOffset + 1L).toInt())
            if (bytesRead <= 0) {
              break
            }

            val writeStartedAt = SystemClock.elapsedRealtimeNanos()
            file.seek(nextOffset)
            file.write(buffer, 0, bytesRead)
            localDiskWriteDurationMs += elapsedMillis(writeStartedAt)
            nextOffset += bytesRead
            chunkBytesTransferred += bytesRead

            synchronized(progressLock) {
              bytesTransferred += bytesRead.toLong()
            }

            throttleChunkBytes(
              bytesTransferred = chunkBytesTransferred,
              maxBytesPerSecond = maxBytesPerSecond,
              startedAt = requestStartedAt,
            )
          }
        }

        if (chunkBytesTransferred != expectedChunkBytes) {
          throw IllegalStateException("The sender returned an incomplete file chunk.")
        }
      } finally {
        synchronized(progressLock) {
          requestDurationMs += elapsedMillis(requestStartedAt)
          diskWriteDurationMs += localDiskWriteDurationMs
        }
        activeConnection = null
        connection.disconnect()
      }
    }
  }

  private data class ParsedRange(
    val end: Long,
    val partial: Boolean,
    val start: Long,
    val total: Long?,
  )

  private data class ParsedHttpRequest(
    val headers: Map<String, String>,
    val httpVersion: String,
    val method: String,
    val path: String,
  )

  private val payloadSessions = ConcurrentHashMap<String, PayloadSession>()
  private val payloadMetrics = ConcurrentHashMap<String, MutableList<PayloadMetric>>()
  private val payloadServer = PayloadServer()
  private val downloadTasks = ConcurrentHashMap<String, RangeDownloadTask>()
  private val ioExecutor: ExecutorService = Executors.newCachedThreadPool()

  override fun definition() = ModuleDefinition {
    Name("DirectTransferNative")

    AsyncFunction("ensurePayloadServerStarted") { promise: Promise ->
      try {
        promise.resolve(
          mapOf(
            "port" to payloadServer.ensureStarted().toDouble(),
          ),
        )
      } catch (error: Exception) {
        promise.reject("ERR_DIRECT_TRANSFER_SERVER_START", error.message, error)
      }
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("stopPayloadServer") {
      payloadServer.stop()
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("registerPayloadSession") { options: Map<String, Any?> ->
      val sessionId = options.requiredString("sessionId")
      val files = options.requiredFiles("files")
      val maxBytesPerSecond = options.optionalLong("maxBytesPerSecond")

      payloadSessions[sessionId] = PayloadSession(
        filesById = files.associateBy { file -> file.id },
        maxBytesPerSecond = maxBytesPerSecond,
        sessionId = sessionId,
      )
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("unregisterPayloadSession") { sessionId: String ->
      payloadSessions.remove(sessionId)
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("collectPayloadMetrics") { sessionId: String ->
      val metrics = payloadMetrics.remove(sessionId) ?: mutableListOf()
      metrics.map { metric -> metric.toMap() }
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("exportFileToDownloads") { options: Map<String, Any?> ->
      exportFileToDownloads(
        sourceUri = options.requiredString("sourceUri"),
        fileName = options.requiredString("fileName"),
        mimeType = options.requiredString("mimeType"),
      )
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("shareFileUri") { uri: String, mimeType: String ->
      shareFileUri(uri = uri, mimeType = mimeType)
    }

    AsyncFunction("startRangeDownload") { options: Map<String, Any?>, promise: Promise ->
      try {
        val task = RangeDownloadTask(
          taskId = options.requiredString("taskId"),
          url = options.requiredString("url"),
          destinationUri = options.requiredString("destinationUri"),
          headers = options.requiredStringMap("headers"),
          totalBytes = options.requiredLong("totalBytes"),
          chunkBytes = options.requiredInt("chunkBytes"),
          maxBytesPerSecond = options.optionalLong("maxBytesPerSecond"),
        )

        if (downloadTasks.putIfAbsent(options.requiredString("taskId"), task) != null) {
          throw IllegalStateException("That native download task already exists.")
        }

        ioExecutor.execute {
          try {
            promise.resolve(task.run())
          } catch (error: Exception) {
            promise.reject("ERR_DIRECT_TRANSFER_DOWNLOAD", error.message, error)
          } finally {
            downloadTasks.remove(options.requiredString("taskId"))
          }
        }
      } catch (error: Exception) {
        promise.reject("ERR_DIRECT_TRANSFER_DOWNLOAD_START", error.message, error)
      }
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("getRangeDownloadProgress") { taskId: String ->
      downloadTasks[taskId]?.snapshot()
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("cancelRangeDownload") { taskId: String ->
      downloadTasks[taskId]?.cancel()
    }.runOnQueue(Queues.DEFAULT)

    OnDestroy {
      payloadServer.stop()
      downloadTasks.values.forEach { task ->
        task.cancel()
      }
      downloadTasks.clear()
      ioExecutor.shutdownNow()
    }
  }

  private fun handlePayloadConnection(socket: Socket) {
    socket.use { client ->
      try {
        val input = BufferedInputStream(client.getInputStream())
        val output = BufferedOutputStream(client.getOutputStream())

        repeat(PAYLOAD_KEEP_ALIVE_MAX_REQUESTS.toInt()) {
          val request = try {
            parseHttpRequest(input)
          } catch (_: SocketTimeoutException) {
            return
          }
          if (request == null) {
            return
          }

          val keepAlive = shouldKeepAlive(request, requestIndex = it)
          val shouldContinue =
            try {
              handlePayloadRequest(output, request, keepAlive)
            } catch (error: Exception) {
              runCatching {
                writeTextResponse(
                  output,
                  500,
                  error.message ?: "Internal direct transfer error.",
                  keepAlive = false,
                )
              }
              false
            }
          if (!shouldContinue) {
            return
          }
        }
      } catch (_: SocketTimeoutException) {
        // Idle keep-alive sockets time out and close quietly.
      } catch (_: Exception) {
        // Ignore per-request failures after best-effort cleanup.
      }
    }
  }

  private fun handlePayloadRequest(
    output: BufferedOutputStream,
    request: ParsedHttpRequest,
    keepAlive: Boolean,
  ): Boolean {
    val pathSegments = request.path.split("/").filter { segment -> segment.isNotEmpty() }
    if (
      pathSegments.size < 5 ||
      pathSegments[0] != "direct" ||
      pathSegments[1] != "sessions" ||
      pathSegments[3] != "files"
    ) {
      writeTextResponse(output, 404, "Not found.", keepAlive = keepAlive)
      return keepAlive
    }

    val sessionId = decodePathSegment(pathSegments[2])
    val fileId = decodePathSegment(pathSegments[4])
    val session = payloadSessions[sessionId]
    if (session == null) {
      writeTextResponse(output, 404, "Direct transfer session not found.", keepAlive = keepAlive)
      return keepAlive
    }

    val file = session.filesById[fileId]
    if (file == null) {
      writeTextResponse(output, 404, "File not found.", keepAlive = keepAlive)
      return keepAlive
    }

    val fileSize = resolvePayloadFileSize(file)
    if (fileSize < 0L) {
      writeTextResponse(output, 410, "The selected file is no longer available on this device.", keepAlive = keepAlive)
      return keepAlive
    }

    val range = resolveRange(request.headers["range"], fileSize)
    if (range == null) {
      writeTextResponse(
        output,
        416,
        "Requested range is not satisfiable.",
        keepAlive = keepAlive,
        extraHeaders = mapOf(
          "Accept-Ranges" to "bytes",
          "Content-Range" to "bytes */$fileSize",
        ),
      )
      return keepAlive
    }

    val contentLength = if (fileSize == 0L) 0L else range.end - range.start + 1L
    val headers = linkedMapOf(
      "Cache-Control" to "no-store",
      "Content-Type" to file.mimeType.ifBlank { "application/octet-stream" },
      "Content-Length" to contentLength.toString(),
      "Accept-Ranges" to "bytes",
    )
    if (range.partial && fileSize > 0L) {
      headers["Content-Range"] = "bytes ${range.start}-${range.end}/$fileSize"
    }

    val statusCode = if (range.partial) 206 else 200
    output.write(createResponseHeaders(statusCode, headers, keepAlive = keepAlive))

    if (request.method == "HEAD" || contentLength == 0L) {
      output.flush()
      return keepAlive
    }

    val requestStartedAt = SystemClock.elapsedRealtimeNanos()
    val streamedRange = streamPayloadRange(
      file = file,
      rangeStart = range.start,
      contentLength = contentLength,
      output = output,
      maxBytesPerSecond = session.maxBytesPerSecond,
      requestStartedAt = requestStartedAt,
    )

    appendPayloadMetric(
      sessionId = sessionId,
      metric = PayloadMetric(
        sessionId = sessionId,
        fileId = fileId,
        bytesServed = streamedRange.bytesServed,
        fileReadDurationMs = streamedRange.fileReadDurationMs,
        responseCopyDurationMs = 0.0,
        totalDurationMs = elapsedMillis(requestStartedAt),
        usedNativeServer = true,
      ),
    )

    return keepAlive
  }

  private fun appendPayloadMetric(sessionId: String, metric: PayloadMetric) {
    val list = payloadMetrics.getOrPut(sessionId) {
      mutableListOf()
    }
    synchronized(list) {
      list += metric
    }
  }

  private fun parseHttpRequest(inputStream: InputStream): ParsedHttpRequest? {
    val bytes = ByteArrayOutputStream()
    val rollingWindow = ArrayDeque<Byte>()

    while (bytes.size() < HEADER_LIMIT_BYTES) {
      val nextByte = inputStream.read()
      if (nextByte < 0) {
        break
      }

      val asByte = nextByte.toByte()
      bytes.write(nextByte)
      rollingWindow += asByte
      if (rollingWindow.size > HEADER_TERMINATOR.length) {
        rollingWindow.removeFirst()
      }
      if (rollingWindow.size == HEADER_TERMINATOR.length) {
        val maybeTerminator = String(
          rollingWindow.toByteArray(),
          StandardCharsets.ISO_8859_1,
        )
        if (maybeTerminator == HEADER_TERMINATOR) {
          break
        }
      }
    }

    val rawRequest = bytes.toString(StandardCharsets.ISO_8859_1.name())
    if (!rawRequest.contains(HEADER_TERMINATOR)) {
      return null
    }

    val lines = rawRequest.substringBefore(HEADER_TERMINATOR).split("\r\n")
    val requestLine = lines.firstOrNull()?.trim().orEmpty()
    if (requestLine.isEmpty()) {
      return null
    }

    val requestLineParts = requestLine.split(" ")
    if (requestLineParts.size < 2) {
      return null
    }

    val headers = linkedMapOf<String, String>()
    lines.drop(1).forEach { line ->
      val separatorIndex = line.indexOf(':')
      if (separatorIndex <= 0) {
        return@forEach
      }
      val key = line.substring(0, separatorIndex).trim().lowercase()
      val value = line.substring(separatorIndex + 1).trim()
      headers[key] = value
    }

    return ParsedHttpRequest(
      httpVersion = requestLineParts.getOrElse(2) { "HTTP/1.1" }.trim().uppercase(),
      method = requestLineParts[0].trim().uppercase(),
      path = requestLineParts[1].trim().substringBefore('?'),
      headers = headers,
    )
  }

  private fun shouldKeepAlive(request: ParsedHttpRequest, requestIndex: Int): Boolean {
    if (requestIndex >= PAYLOAD_KEEP_ALIVE_MAX_REQUESTS - 1) {
      return false
    }

    val connection = request.headers["connection"]?.trim()?.lowercase()
    if (connection == "close") {
      return false
    }

    return if (request.httpVersion == "HTTP/1.0") {
      connection == "keep-alive"
    } else {
      true
    }
  }

  private fun createResponseHeaders(
    statusCode: Int,
    headers: Map<String, String>,
    keepAlive: Boolean,
  ): ByteArray {
    val builder = StringBuilder()
    builder.append("HTTP/1.1 ").append(statusCode).append(' ').append(reasonPhrase(statusCode)).append("\r\n")
    headers.forEach { (key, value) ->
      builder.append(key).append(": ").append(value).append("\r\n")
    }
    builder.append("Connection: ").append(if (keepAlive) "keep-alive" else "close").append("\r\n")
    if (keepAlive) {
      builder.append("Keep-Alive: timeout=${PAYLOAD_KEEP_ALIVE_IDLE_TIMEOUT_MS / 1000}, max=$PAYLOAD_KEEP_ALIVE_MAX_REQUESTS\r\n")
    }
    builder.append("\r\n")
    return builder.toString().toByteArray(StandardCharsets.ISO_8859_1)
  }

  private fun writeTextResponse(
    output: BufferedOutputStream,
    statusCode: Int,
    body: String,
    keepAlive: Boolean,
    extraHeaders: Map<String, String> = emptyMap(),
  ) {
    val bodyBytes = body.toByteArray(StandardCharsets.UTF_8)
    val headers = linkedMapOf(
      "Cache-Control" to "no-store",
      "Content-Type" to "text/plain; charset=utf-8",
      "Content-Length" to bodyBytes.size.toString(),
    )
    headers.putAll(extraHeaders)
    output.write(createResponseHeaders(statusCode, headers, keepAlive = keepAlive))
    output.write(bodyBytes)
    output.flush()
  }

  private fun resolveRange(rangeHeader: String?, fileSize: Long): ParsedRange? {
    if (rangeHeader.isNullOrBlank()) {
      return ParsedRange(
        start = 0,
        end = (fileSize - 1L).coerceAtLeast(0L),
        partial = false,
        total = fileSize,
      )
    }

    val match = Regex("^bytes=(\\d+)-(\\d+)$", RegexOption.IGNORE_CASE).find(rangeHeader.trim()) ?: return null
    val start = match.groupValues[1].toLongOrNull() ?: return null
    val end = match.groupValues[2].toLongOrNull() ?: return null
    if (start < 0L || end < start || start >= fileSize) {
      return null
    }

    return ParsedRange(
      start = start,
      end = min(end, fileSize - 1L),
      partial = true,
      total = fileSize,
    )
  }

  private fun parseContentRange(value: String?): ParsedRange? {
    if (value.isNullOrBlank()) {
      return null
    }

    val match = Regex("^bytes (\\d+)-(\\d+)/(\\d+|\\*)$", RegexOption.IGNORE_CASE).find(value.trim()) ?: return null
    val start = match.groupValues[1].toLongOrNull() ?: return null
    val end = match.groupValues[2].toLongOrNull() ?: return null
    val total = if (match.groupValues[3] == "*") null else match.groupValues[3].toLongOrNull()
    return ParsedRange(
      start = start,
      end = end,
      partial = true,
      total = total,
    )
  }

  private fun reasonPhrase(statusCode: Int): String {
    return when (statusCode) {
      200 -> "OK"
      206 -> "Partial Content"
      400 -> "Bad Request"
      401 -> "Unauthorized"
      404 -> "Not Found"
      500 -> "Internal Server Error"
      410 -> "Gone"
      416 -> "Range Not Satisfiable"
      else -> "Error"
    }
  }

  private fun decodePathSegment(value: String): String {
    return URLDecoder.decode(value, StandardCharsets.UTF_8.name())
  }

  private fun exportFileToDownloads(
    sourceUri: String,
    fileName: String,
    mimeType: String,
  ): Map<String, Any> {
    val context = appContext.reactContext ?: throw IllegalStateException("React context is unavailable.")
    val resolver = context.contentResolver
    val normalizedMimeType = mimeType.ifBlank { "application/octet-stream" }
    val normalizedFileName = fileName.trim().ifEmpty { "file" }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, normalizedFileName)
        put(MediaStore.MediaColumns.MIME_TYPE, normalizedMimeType)
        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val destinationUri =
        resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
          ?: throw IllegalStateException("Unable to create a Downloads file.")

      try {
        copyUriContents(resolver = resolver, sourceUri = sourceUri, destinationUri = destinationUri.toString())
        val publishValues = ContentValues().apply {
          put(MediaStore.MediaColumns.IS_PENDING, 0)
        }
        resolver.update(destinationUri, publishValues, null, null)
        return mapOf(
          "uri" to destinationUri.toString(),
        )
      } catch (error: Exception) {
        runCatching {
          resolver.delete(destinationUri, null, null)
        }
        throw error
      }
    }

    val downloadsDirectory = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
    if (!downloadsDirectory.exists() && !downloadsDirectory.mkdirs()) {
      throw IllegalStateException("Unable to access the Downloads directory.")
    }
    val destinationFile = createUniqueDownloadFile(downloadsDirectory, normalizedFileName)

    openInputStream(resolver = resolver, uri = sourceUri).use { input ->
      FileOutputStream(destinationFile).use { output ->
        input.copyTo(output, IO_PAGE_BYTES)
      }
    }

    return mapOf(
      "uri" to Uri.fromFile(destinationFile).toString(),
    )
  }

  private fun shareFileUri(uri: String, mimeType: String) {
    val context = appContext.reactContext ?: throw IllegalStateException("React context is unavailable.")
    val parsedUri = Uri.parse(uri)
    val shareIntent =
      Intent(Intent.ACTION_SEND).apply {
        putExtra(Intent.EXTRA_STREAM, parsedUri)
        setTypeAndNormalize(mimeType.ifBlank { "*/*" })
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
    val chooserIntent = Intent.createChooser(shareIntent, null).apply {
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val resInfoList =
      context.packageManager.queryIntentActivities(chooserIntent, PackageManager.MATCH_DEFAULT_ONLY)
    resInfoList.forEach { resolveInfo ->
      context.grantUriPermission(
        resolveInfo.activityInfo.packageName,
        parsedUri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION,
      )
    }

    appContext.throwingActivity.startActivity(chooserIntent)
  }

  private fun requireFilePath(uri: String): String {
    val parsed = Uri.parse(uri)
    if (parsed.scheme.isNullOrBlank() || parsed.scheme == "file") {
      return parsed.path ?: uri.removePrefix("file://")
    }
    throw IllegalStateException("Only file:// URIs are supported for direct transfer.")
  }

  private data class StreamedPayloadRange(
    val bytesServed: Long,
    val fileReadDurationMs: Double,
  )

  private fun resolvePayloadFileSize(file: PayloadFile): Long {
    if (file.sizeBytes > 0L) {
      return file.sizeBytes
    }

    val parsed = Uri.parse(file.uri)
    return when (parsed.scheme) {
      null,
      "",
      "file" -> {
        val sourceFile = File(requireFilePath(file.uri))
        if (!sourceFile.exists()) {
          -1L
        } else {
          sourceFile.length()
        }
      }
      "content" -> {
        val resolver = requireContentResolver()
        val descriptor = resolver.openFileDescriptor(parsed, "r") ?: return -1L
        descriptor.use {
          if (it.statSize >= 0L) {
            return it.statSize
          }
        }
        queryContentSizeBytes(resolver, parsed)
      }
      else -> throw IllegalStateException("Unsupported direct transfer URI scheme.")
    }
  }

  private fun streamPayloadRange(
    file: PayloadFile,
    rangeStart: Long,
    contentLength: Long,
    output: BufferedOutputStream,
    maxBytesPerSecond: Long?,
    requestStartedAt: Long,
  ): StreamedPayloadRange {
    val parsed = Uri.parse(file.uri)
    return when (parsed.scheme) {
      null,
      "",
      "file" -> streamFilePayloadRange(
        filePath = requireFilePath(file.uri),
        rangeStart = rangeStart,
        contentLength = contentLength,
        output = output,
        maxBytesPerSecond = maxBytesPerSecond,
        requestStartedAt = requestStartedAt,
      )
      "content" -> streamContentPayloadRange(
        contentUri = parsed,
        rangeStart = rangeStart,
        contentLength = contentLength,
        output = output,
        maxBytesPerSecond = maxBytesPerSecond,
        requestStartedAt = requestStartedAt,
      )
      else -> throw IllegalStateException("Unsupported direct transfer URI scheme.")
    }
  }

  private fun streamFilePayloadRange(
    filePath: String,
    rangeStart: Long,
    contentLength: Long,
    output: BufferedOutputStream,
    maxBytesPerSecond: Long?,
    requestStartedAt: Long,
  ): StreamedPayloadRange {
    val sourceFile = File(filePath)
    if (!sourceFile.exists()) {
      throw IllegalStateException("The selected file is no longer available on this device.")
    }

    var bytesServed = 0L
    var fileReadDurationMs = 0.0
    RandomAccessFile(sourceFile, "r").use { input ->
      input.seek(rangeStart)
      val buffer = ByteArray(IO_PAGE_BYTES)
      var remaining = contentLength
      while (remaining > 0) {
        val nextReadLength = min(buffer.size.toLong(), remaining).toInt()
        val readStartedAt = SystemClock.elapsedRealtimeNanos()
        val bytesRead = input.read(buffer, 0, nextReadLength)
        fileReadDurationMs += elapsedMillis(readStartedAt)
        if (bytesRead <= 0) {
          break
        }

        output.write(buffer, 0, bytesRead)
        bytesServed += bytesRead.toLong()
        remaining -= bytesRead.toLong()

        throttleChunkBytes(
          bytesTransferred = bytesServed,
          maxBytesPerSecond = maxBytesPerSecond,
          startedAt = requestStartedAt,
        )
      }
      output.flush()
    }

    return StreamedPayloadRange(
      bytesServed = bytesServed,
      fileReadDurationMs = fileReadDurationMs,
    )
  }

  private fun streamContentPayloadRange(
    contentUri: Uri,
    rangeStart: Long,
    contentLength: Long,
    output: BufferedOutputStream,
    maxBytesPerSecond: Long?,
    requestStartedAt: Long,
  ): StreamedPayloadRange {
    val resolver = requireContentResolver()
    val descriptor =
      resolver.openFileDescriptor(contentUri, "r")
        ?: throw IllegalStateException("Unable to open the selected file for direct transfer.")

    var bytesServed = 0L
    var fileReadDurationMs = 0.0
    descriptor.use { parcelFileDescriptor ->
      FileInputStream(parcelFileDescriptor.fileDescriptor).use { input ->
        input.channel.position(rangeStart)
        val buffer = ByteArray(IO_PAGE_BYTES)
        var remaining = contentLength
        while (remaining > 0) {
          val nextReadLength = min(buffer.size.toLong(), remaining).toInt()
          val readStartedAt = SystemClock.elapsedRealtimeNanos()
          val bytesRead = input.read(buffer, 0, nextReadLength)
          fileReadDurationMs += elapsedMillis(readStartedAt)
          if (bytesRead <= 0) {
            break
          }

          output.write(buffer, 0, bytesRead)
          bytesServed += bytesRead.toLong()
          remaining -= bytesRead.toLong()

          throttleChunkBytes(
            bytesTransferred = bytesServed,
            maxBytesPerSecond = maxBytesPerSecond,
            startedAt = requestStartedAt,
          )
        }
        output.flush()
      }
    }

    return StreamedPayloadRange(
      bytesServed = bytesServed,
      fileReadDurationMs = fileReadDurationMs,
    )
  }

  private fun queryContentSizeBytes(
    resolver: android.content.ContentResolver,
    contentUri: Uri,
  ): Long {
    resolver.query(contentUri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
      val sizeColumnIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
      if (sizeColumnIndex >= 0 && cursor.moveToFirst() && !cursor.isNull(sizeColumnIndex)) {
        return cursor.getLong(sizeColumnIndex)
      }
    }
    return -1L
  }

  private fun requireContentResolver(): android.content.ContentResolver {
    val context = appContext.reactContext ?: throw IllegalStateException("React context is unavailable.")
    return context.contentResolver
  }

  private fun throttleChunkBytes(bytesTransferred: Long, maxBytesPerSecond: Long?, startedAt: Long) {
    if (maxBytesPerSecond == null || maxBytesPerSecond <= 0L || bytesTransferred <= 0L) {
      return
    }

    val minimumDurationMs = ceil((bytesTransferred.toDouble() / maxBytesPerSecond.toDouble()) * 1000.0).toLong()
    val elapsedMs = elapsedMillis(startedAt).toLong()
    val remainingMs = minimumDurationMs - elapsedMs
    if (remainingMs > 0L) {
      Thread.sleep(remainingMs)
    }
  }

  private fun elapsedMillis(startedAt: Long): Double {
    return (SystemClock.elapsedRealtimeNanos() - startedAt) / 1_000_000.0
  }

  private fun Map<String, Any?>.requiredString(key: String): String {
    return this[key] as? String ?: throw IllegalStateException("Missing \"$key\".")
  }

  private fun Map<String, Any?>.requiredInt(key: String): Int {
    val value = this[key]
    return when (value) {
      is Int -> value
      is Double -> value.toInt()
      is Long -> value.toInt()
      else -> throw IllegalStateException("Missing \"$key\".")
    }
  }

  private fun Map<String, Any?>.requiredLong(key: String): Long {
    val value = this[key]
    return when (value) {
      is Int -> value.toLong()
      is Double -> value.toLong()
      is Long -> value
      else -> throw IllegalStateException("Missing \"$key\".")
    }
  }

  private fun Map<String, Any?>.optionalLong(key: String): Long? {
    val value = this[key] ?: return null
    return when (value) {
      is Int -> value.toLong()
      is Double -> value.toLong()
      is Long -> value
      else -> null
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun Map<String, Any?>.requiredStringMap(key: String): Map<String, String> {
    val rawValue = this[key] as? Map<*, *> ?: return emptyMap()
    return rawValue.entries.associate { (rawKey, rawValueEntry) ->
      (rawKey as? String ?: "").trim() to (rawValueEntry as? String ?: "")
    }.filterKeys { mapKey -> mapKey.isNotEmpty() }
  }

  @Suppress("UNCHECKED_CAST")
  private fun Map<String, Any?>.requiredFiles(key: String): List<PayloadFile> {
    val entries = this[key] as? List<Map<String, Any?>> ?: throw IllegalStateException("Missing \"$key\".")
    return entries.map { entry ->
      PayloadFile(
        id = entry["id"] as? String ?: throw IllegalStateException("Missing file id."),
        uri = entry["uri"] as? String ?: throw IllegalStateException("Missing file uri."),
        mimeType = (entry["mimeType"] as? String).orEmpty(),
        sizeBytes = when (val size = entry["sizeBytes"]) {
          is Int -> size.toLong()
          is Double -> size.toLong()
          is Long -> size
          else -> 0L
        },
      )
    }
  }

  private fun copyUriContents(
    resolver: android.content.ContentResolver,
    sourceUri: String,
    destinationUri: String,
  ) {
    openInputStream(resolver = resolver, uri = sourceUri).use { input ->
      val parsedDestinationUri = Uri.parse(destinationUri)
      resolver.openOutputStream(parsedDestinationUri, "w").use { output ->
        requireNotNull(output) {
          "Unable to open the Downloads destination."
        }
        input.copyTo(output, IO_PAGE_BYTES)
      }
    }
  }

  private fun openInputStream(
    resolver: android.content.ContentResolver,
    uri: String,
  ): InputStream {
    val parsed = Uri.parse(uri)
    return when (parsed.scheme) {
      null,
      "",
      "file" -> FileInputStream(requireFilePath(uri))
      "content" ->
        resolver.openInputStream(parsed)
          ?: throw IllegalStateException("Unable to open the source file for export.")
      else -> throw IllegalStateException("Unsupported source URI scheme for export.")
    }
  }

  private fun createUniqueDownloadFile(
    downloadsDirectory: File,
    fileName: String,
  ): File {
    val extensionIndex = fileName.lastIndexOf('.')
    val basename =
      if (extensionIndex <= 0) {
        fileName
      } else {
        fileName.substring(0, extensionIndex)
      }
    val extension =
      if (extensionIndex <= 0) {
        ""
      } else {
        fileName.substring(extensionIndex)
      }

    var attempt = 0
    while (true) {
      val suffix = if (attempt == 0) "" else " ($attempt)"
      val candidate = File(downloadsDirectory, "$basename$suffix$extension")
      if (!candidate.exists()) {
        return candidate
      }
      attempt += 1
    }
  }

  private fun ServerSocket.closeQuietly() {
    runCatching {
      close()
    }
  }
}
