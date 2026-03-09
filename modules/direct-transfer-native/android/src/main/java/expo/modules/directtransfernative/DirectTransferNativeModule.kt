package expo.modules.directtransfernative

import android.net.Uri
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.URL
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.ceil
import kotlin.math.min

private const val HEADER_TERMINATOR = "\r\n\r\n"
private const val HEADER_LIMIT_BYTES = 64 * 1024
private const val IO_PAGE_BYTES = 256 * 1024

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
    val token: String,
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
    private val maxConcurrentChunks: Int,
    private val taskId: String,
    private val totalBytes: Long,
    private val url: String,
  ) {
    private val cancelled = AtomicBoolean(false)
    private val chunkIndex = AtomicInteger(0)
    private val activeConnections = CopyOnWriteArrayList<HttpURLConnection>()
    private val progressLock = Any()
    private val startedAtMs = System.currentTimeMillis().toDouble()

    @Volatile
    private var bytesTransferred = 0L
    @Volatile
    private var requestDurationMs = 0.0
    @Volatile
    private var diskWriteDurationMs = 0.0

    fun cancel() {
      cancelled.set(true)
      activeConnections.forEach { connection ->
        runCatching {
          connection.disconnect()
        }
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
      val workerCount = maxConcurrentChunks.coerceAtLeast(1)
      val futures = mutableListOf<Future<*>>()

      repeat(workerCount) {
        futures += ioExecutor.submit {
          RandomAccessFile(outputFile, "rw").use { file ->
            while (!cancelled.get()) {
              val currentChunkIndex = chunkIndex.getAndIncrement()
              if (currentChunkIndex >= chunkCount) {
                break
              }

              val start = currentChunkIndex.toLong() * chunkBytes.toLong()
              val end = min(start + chunkBytes - 1L, totalBytes - 1L)
              downloadChunk(file, start, end)
            }
          }
        }
      }

      futures.forEach { future ->
        future.get()
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
      activeConnections += connection

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
        activeConnections -= connection
        synchronized(progressLock) {
          requestDurationMs += elapsedMillis(requestStartedAt)
          diskWriteDurationMs += localDiskWriteDurationMs
        }
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
      val token = options.requiredString("token")
      val files = options.requiredFiles("files")
      val maxBytesPerSecond = options.optionalLong("maxBytesPerSecond")

      payloadSessions[sessionId] = PayloadSession(
        filesById = files.associateBy { file -> file.id },
        maxBytesPerSecond = maxBytesPerSecond,
        sessionId = sessionId,
        token = token,
      )
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("unregisterPayloadSession") { sessionId: String ->
      payloadSessions.remove(sessionId)
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("collectPayloadMetrics") { sessionId: String ->
      val metrics = payloadMetrics.remove(sessionId) ?: mutableListOf()
      metrics.map { metric -> metric.toMap() }
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("startRangeDownload") { options: Map<String, Any?>, promise: Promise ->
      try {
        val task = RangeDownloadTask(
          taskId = options.requiredString("taskId"),
          url = options.requiredString("url"),
          destinationUri = options.requiredString("destinationUri"),
          headers = options.requiredStringMap("headers"),
          totalBytes = options.requiredLong("totalBytes"),
          chunkBytes = options.requiredInt("chunkBytes"),
          maxConcurrentChunks = options.requiredInt("maxConcurrentChunks"),
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
        val request = parseHttpRequest(client.getInputStream())
        if (request == null) {
          writeTextResponse(client, 400, "Invalid request.")
          return
        }

        val pathSegments = request.path.split("/").filter { segment -> segment.isNotEmpty() }
        if (
          pathSegments.size < 5 ||
          pathSegments[0] != "direct" ||
          pathSegments[1] != "sessions" ||
          pathSegments[3] != "files"
        ) {
          writeTextResponse(client, 404, "Not found.")
          return
        }

        val sessionId = decodePathSegment(pathSegments[2])
        val fileId = decodePathSegment(pathSegments[4])
        val session = payloadSessions[sessionId]
        if (session == null) {
          writeTextResponse(client, 404, "Direct transfer session not found.")
          return
        }

        val token = request.headers["x-direct-token"]
        if (token == null || token != session.token) {
          writeTextResponse(client, 401, "Unauthorized direct transfer request.")
          return
        }

        val file = session.filesById[fileId]
        if (file == null) {
          writeTextResponse(client, 404, "File not found.")
          return
        }

        val filePath = requireFilePath(file.uri)
        val sourceFile = File(filePath)
        if (!sourceFile.exists()) {
          writeTextResponse(client, 410, "The selected file is no longer available on this device.")
          return
        }

        val fileSize = if (file.sizeBytes > 0) file.sizeBytes else sourceFile.length()
        val range = resolveRange(request.headers["range"], fileSize)
        if (range == null) {
          writeTextResponse(
            client,
            416,
            "Requested range is not satisfiable.",
            extraHeaders = mapOf(
              "Accept-Ranges" to "bytes",
              "Content-Range" to "bytes */$fileSize",
            ),
          )
          return
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

        val output = BufferedOutputStream(client.getOutputStream())
        val statusCode = if (range.partial) 206 else 200
        output.write(createResponseHeaders(statusCode, headers))

        if (request.method == "HEAD" || contentLength == 0L) {
          output.flush()
          return
        }

        val requestStartedAt = SystemClock.elapsedRealtimeNanos()
        var bytesServed = 0L
        var fileReadDurationMs = 0.0

        RandomAccessFile(sourceFile, "r").use { input ->
          input.seek(range.start)
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
              maxBytesPerSecond = session.maxBytesPerSecond,
              startedAt = requestStartedAt,
            )
          }
          output.flush()
        }

        appendPayloadMetric(
          sessionId = sessionId,
          metric = PayloadMetric(
            sessionId = sessionId,
            fileId = fileId,
            bytesServed = bytesServed,
            fileReadDurationMs = fileReadDurationMs,
            responseCopyDurationMs = 0.0,
            totalDurationMs = elapsedMillis(requestStartedAt),
            usedNativeServer = true,
          ),
        )
      } catch (_: Exception) {
        // Ignore per-request failures after best-effort cleanup.
      }
    }
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
      method = requestLineParts[0].trim().uppercase(),
      path = requestLineParts[1].trim().substringBefore('?'),
      headers = headers,
    )
  }

  private fun createResponseHeaders(statusCode: Int, headers: Map<String, String>): ByteArray {
    val builder = StringBuilder()
    builder.append("HTTP/1.1 ").append(statusCode).append(' ').append(reasonPhrase(statusCode)).append("\r\n")
    headers.forEach { (key, value) ->
      builder.append(key).append(": ").append(value).append("\r\n")
    }
    builder.append("Connection: close\r\n")
    builder.append("\r\n")
    return builder.toString().toByteArray(StandardCharsets.ISO_8859_1)
  }

  private fun writeTextResponse(
    socket: Socket,
    statusCode: Int,
    body: String,
    extraHeaders: Map<String, String> = emptyMap(),
  ) {
    val bodyBytes = body.toByteArray(StandardCharsets.UTF_8)
    val output = BufferedOutputStream(socket.getOutputStream())
    val headers = linkedMapOf(
      "Cache-Control" to "no-store",
      "Content-Type" to "text/plain; charset=utf-8",
      "Content-Length" to bodyBytes.size.toString(),
    )
    headers.putAll(extraHeaders)
    output.write(createResponseHeaders(statusCode, headers))
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
      410 -> "Gone"
      416 -> "Range Not Satisfiable"
      else -> "Error"
    }
  }

  private fun decodePathSegment(value: String): String {
    return URLDecoder.decode(value, StandardCharsets.UTF_8.name())
  }

  private fun requireFilePath(uri: String): String {
    val parsed = Uri.parse(uri)
    if (parsed.scheme.isNullOrBlank() || parsed.scheme == "file") {
      return parsed.path ?: uri.removePrefix("file://")
    }
    throw IllegalStateException("Only file:// URIs are supported for direct transfer.")
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

  private fun ServerSocket.closeQuietly() {
    runCatching {
      close()
    }
  }
}
