import ExpoModulesCore
import Foundation
import Network

private let headerLimitBytes = 64 * 1024
private let ioPageBytes = 256 * 1024

private func logDirectTransferNativeDebug(_ message: String, details: [String: Any] = [:]) {
  #if DEBUG
  if details.isEmpty {
    NSLog("[DirectTransferNative] %@", message)
  } else {
    NSLog("[DirectTransferNative] %@ %@", message, String(describing: details))
  }
  #endif
}

private func getSessionDebugId(_ sessionId: String) -> String {
  String(sessionId.prefix(8))
}

private func getTokenDebugSuffix(_ token: String) -> String {
  String(token.suffix(6))
}

private func getUrlDebugDetails(_ url: URL) -> [String: Any] {
  [
    "host": url.host ?? "",
    "port": url.port ?? (url.scheme == "https" ? 443 : 80),
    "path": url.path,
    "scheme": url.scheme ?? "",
  ]
}

private struct PayloadFile {
  let id: String
  let mimeType: String
  let sizeBytes: Int64
  let uri: String
}

private struct PayloadSession {
  let filesById: [String: PayloadFile]
  let maxBytesPerSecond: Int64?
  let sessionId: String
  let token: String
}

private struct PayloadMetric {
  let bytesServed: Int64
  let fileId: String
  let fileReadDurationMs: Double
  let responseCopyDurationMs: Double
  let sessionId: String
  let totalDurationMs: Double
  let usedNativeServer: Bool

  var dictionary: [String: Any] {
    [
      "sessionId": sessionId,
      "fileId": fileId,
      "bytesServed": Double(bytesServed),
      "fileReadDurationMs": fileReadDurationMs,
      "responseCopyDurationMs": responseCopyDurationMs,
      "totalDurationMs": totalDurationMs,
      "usedNativeServer": usedNativeServer
    ]
  }
}

private struct ParsedRange {
  let end: Int64
  let partial: Bool
  let start: Int64
  let total: Int64?
}

private struct ParsedHttpRequest {
  let headers: [String: String]
  let method: String
  let path: String
}

private final class ContinuationGate: @unchecked Sendable {
  private let lock = NSLock()
  private var isClaimed = false

  func claim() -> Bool {
    lock.lock()
    defer {
      lock.unlock()
    }

    guard !isClaimed else {
      return false
    }

    isClaimed = true
    return true
  }
}

private final class PayloadServer {
  private let queue = DispatchQueue(label: "DirectTransferNative.PayloadServer")
  private let resolveSession: (String) -> PayloadSession?
  private let appendMetric: (String, PayloadMetric) -> Void
  private var listener: NWListener?

  init(resolveSession: @escaping (String) -> PayloadSession?, appendMetric: @escaping (String, PayloadMetric) -> Void) {
    self.resolveSession = resolveSession
    self.appendMetric = appendMetric
  }

  func ensureStarted() async throws -> UInt16 {
    if let listener, let port = listener.port?.rawValue {
      logDirectTransferNativeDebug("Reusing native payload server", details: [
        "port": port
      ])
      return port
    }

    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, Error>) in
      let gate = ContinuationGate()
      do {
        let listener = try NWListener(using: .tcp, on: .any)
        listener.stateUpdateHandler = { [weak self] state in
          switch state {
          case .ready:
            guard gate.claim() else {
              return
            }
            self?.listener = listener
            logDirectTransferNativeDebug("Native payload server ready", details: [
              "port": listener.port?.rawValue ?? 0
            ])
            continuation.resume(returning: listener.port?.rawValue ?? 0)
          case .failed(let error):
            guard gate.claim() else {
              return
            }
            logDirectTransferNativeDebug("Native payload server failed", details: [
              "error": error.localizedDescription
            ])
            continuation.resume(throwing: error)
          default:
            break
          }
        }
        listener.newConnectionHandler = { [weak self] connection in
          self?.handle(connection: connection)
        }
        listener.start(queue: queue)
      } catch {
        guard gate.claim() else {
          return
        }
        continuation.resume(throwing: error)
      }
    }
  }

  func stop() {
    listener?.cancel()
    listener = nil
  }

  private func handle(connection: NWConnection) {
    connection.start(queue: queue)
    receiveRequest(on: connection, accumulated: Data())
  }

  private func receiveRequest(on connection: NWConnection, accumulated: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, isComplete, error in
      guard let self else {
        connection.cancel()
        return
      }

      if error != nil {
        connection.cancel()
        return
      }

      var combined = accumulated
      if let data {
        combined.append(data)
      }

      if combined.count > headerLimitBytes {
        Task {
          try? await self.sendTextResponse(on: connection, statusCode: 400, body: "Invalid request.")
          connection.cancel()
        }
        return
      }

      if let headerRange = combined.range(of: Data("\r\n\r\n".utf8)) {
        let headerData = combined.subdata(in: 0..<headerRange.upperBound)
        Task {
          await self.process(connection: connection, requestData: headerData)
        }
        return
      }

      if isComplete {
        connection.cancel()
        return
      }

      self.receiveRequest(on: connection, accumulated: combined)
    }
  }

  private func process(connection: NWConnection, requestData: Data) async {
    do {
      guard let request = parseHttpRequest(requestData) else {
        try await sendTextResponse(on: connection, statusCode: 400, body: "Invalid request.")
        connection.cancel()
        return
      }

      let pathSegments = request.path.split(separator: "/").filter { !$0.isEmpty }
      guard pathSegments.count >= 5,
            pathSegments[0] == "direct",
            pathSegments[1] == "sessions",
            pathSegments[3] == "files"
      else {
        try await sendTextResponse(on: connection, statusCode: 404, body: "Not found.")
        connection.cancel()
        return
      }

      let sessionId = decodePathSegment(String(pathSegments[2]))
      let fileId = decodePathSegment(String(pathSegments[4]))
      guard let session = resolveSession(sessionId) else {
        try await sendTextResponse(on: connection, statusCode: 404, body: "Direct transfer session not found.")
        connection.cancel()
        return
      }

      guard let token = request.headers["x-direct-token"], token == session.token else {
        try await sendTextResponse(on: connection, statusCode: 401, body: "Unauthorized direct transfer request.")
        connection.cancel()
        return
      }

      guard let file = session.filesById[fileId] else {
        try await sendTextResponse(on: connection, statusCode: 404, body: "File not found.")
        connection.cancel()
        return
      }

      let fileUrl = try requireFileUrl(file.uri)
      let fileValues = try fileUrl.resourceValues(forKeys: [.fileSizeKey])
      let fileSize = file.sizeBytes > 0 ? file.sizeBytes : Int64(fileValues.fileSize ?? 0)
      guard let range = resolveRange(request.headers["range"], fileSize: fileSize) else {
        try await sendTextResponse(
          on: connection,
          statusCode: 416,
          body: "Requested range is not satisfiable.",
          extraHeaders: [
            "Accept-Ranges": "bytes",
            "Content-Range": "bytes */\(fileSize)"
          ]
        )
        connection.cancel()
        return
      }

      let contentLength = fileSize == 0 ? 0 : range.end - range.start + 1
      var headers: [String: String] = [
        "Cache-Control": "no-store",
        "Content-Type": file.mimeType.isEmpty ? "application/octet-stream" : file.mimeType,
        "Content-Length": "\(contentLength)",
        "Accept-Ranges": "bytes"
      ]
      if range.partial && fileSize > 0 {
        headers["Content-Range"] = "bytes \(range.start)-\(range.end)/\(fileSize)"
      }

      let statusCode = range.partial ? 206 : 200
      try await sendRaw(on: connection, data: responseHeaders(statusCode: statusCode, headers: headers))
      if request.method == "HEAD" || contentLength == 0 {
        try await sendRaw(on: connection, data: nil)
        connection.cancel()
        return
      }

      let requestStartedAt = CACurrentMediaTime()
      var bytesServed: Int64 = 0
      var fileReadDurationMs = 0.0

      let handle = try FileHandle(forReadingFrom: fileUrl)
      defer {
        try? handle.close()
      }
      try handle.seek(toOffset: UInt64(range.start))
      var remaining = contentLength

      while remaining > 0 {
        let readStartedAt = CACurrentMediaTime()
        let nextReadSize = min(Int64(ioPageBytes), remaining)
        let chunk = try handle.read(upToCount: Int(nextReadSize)) ?? Data()
        fileReadDurationMs += (CACurrentMediaTime() - readStartedAt) * 1000
        if chunk.isEmpty {
          break
        }

        try await sendRaw(on: connection, data: chunk)
        bytesServed += Int64(chunk.count)
        remaining -= Int64(chunk.count)
        throttleChunk(bytesTransferred: bytesServed, maxBytesPerSecond: session.maxBytesPerSecond, startedAt: requestStartedAt)
      }

      appendMetric(
        sessionId,
        PayloadMetric(
          bytesServed: bytesServed,
          fileId: fileId,
          fileReadDurationMs: fileReadDurationMs,
          responseCopyDurationMs: 0,
          sessionId: sessionId,
          totalDurationMs: (CACurrentMediaTime() - requestStartedAt) * 1000,
          usedNativeServer: true
        )
      )

      try await sendRaw(on: connection, data: nil)
      connection.cancel()
    } catch {
      connection.cancel()
    }
  }

  private func sendTextResponse(on connection: NWConnection, statusCode: Int, body: String, extraHeaders: [String: String] = [:]) async throws {
    let bodyData = Data(body.utf8)
    var headers = [
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": "\(bodyData.count)"
    ]
    extraHeaders.forEach { headers[$0.key] = $0.value }
    try await sendRaw(on: connection, data: responseHeaders(statusCode: statusCode, headers: headers))
    try await sendRaw(on: connection, data: bodyData)
  }

  private func sendRaw(on connection: NWConnection, data: Data?) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      connection.send(content: data, completion: .contentProcessed { error in
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume()
        }
      })
    }
  }

  private func parseHttpRequest(_ data: Data) -> ParsedHttpRequest? {
    guard let rawRequest = String(data: data, encoding: .isoLatin1) else {
      return nil
    }
    let lines = rawRequest.components(separatedBy: "\r\n")
    guard let requestLine = lines.first?.trimmingCharacters(in: .whitespacesAndNewlines), !requestLine.isEmpty else {
      return nil
    }
    let parts = requestLine.components(separatedBy: " ")
    guard parts.count >= 2 else {
      return nil
    }

    var headers: [String: String] = [:]
    for line in lines.dropFirst() where !line.isEmpty {
      guard let separatorIndex = line.firstIndex(of: ":") else {
        continue
      }
      let key = line[..<separatorIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let value = line[line.index(after: separatorIndex)...].trimmingCharacters(in: .whitespacesAndNewlines)
      headers[key] = value
    }

    return ParsedHttpRequest(
      headers: headers,
      method: parts[0].uppercased(),
      path: parts[1].components(separatedBy: "?").first ?? parts[1]
    )
  }

  private func responseHeaders(statusCode: Int, headers: [String: String]) -> Data {
    var builder = "HTTP/1.1 \(statusCode) \(reasonPhrase(statusCode))\r\n"
    headers.forEach { key, value in
      builder += "\(key): \(value)\r\n"
    }
    builder += "Connection: close\r\n\r\n"
    return Data(builder.utf8)
  }

  private func reasonPhrase(_ statusCode: Int) -> String {
    switch statusCode {
    case 200:
      return "OK"
    case 206:
      return "Partial Content"
    case 400:
      return "Bad Request"
    case 401:
      return "Unauthorized"
    case 404:
      return "Not Found"
    case 410:
      return "Gone"
    case 416:
      return "Range Not Satisfiable"
    default:
      return "Error"
    }
  }

  private func resolveRange(_ rangeHeader: String?, fileSize: Int64) -> ParsedRange? {
    guard let rangeHeader, !rangeHeader.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return ParsedRange(
        end: max(fileSize - 1, 0),
        partial: false,
        start: 0,
        total: fileSize
      )
    }

    let pattern = try? NSRegularExpression(pattern: "^bytes=(\\d+)-(\\d+)$", options: [.caseInsensitive])
    let nsRange = NSRange(location: 0, length: rangeHeader.utf16.count)
    guard let match = pattern?.firstMatch(in: rangeHeader.trimmingCharacters(in: .whitespacesAndNewlines), options: [], range: nsRange),
          let startRange = Range(match.range(at: 1), in: rangeHeader),
          let endRange = Range(match.range(at: 2), in: rangeHeader),
          let start = Int64(rangeHeader[startRange]),
          let end = Int64(rangeHeader[endRange]),
          start >= 0,
          end >= start,
          start < fileSize
    else {
      return nil
    }

    return ParsedRange(
      end: min(end, fileSize - 1),
      partial: true,
      start: start,
      total: fileSize
    )
  }

  private func decodePathSegment(_ value: String) -> String {
    value.removingPercentEncoding ?? value
  }

  private func requireFileUrl(_ uri: String) throws -> URL {
    if uri.hasPrefix("file://"), let url = URL(string: uri) {
      return url
    }

    if uri.contains("://") {
      throw Exception(name: "DirectTransferInvalidUri", description: "Only file:// URIs are supported for direct transfer.", code: "ERR_DIRECT_TRANSFER_URI")
    }

    return URL(fileURLWithPath: uri)
  }

  private func throttleChunk(bytesTransferred: Int64, maxBytesPerSecond: Int64?, startedAt: CFTimeInterval) {
    guard let maxBytesPerSecond, maxBytesPerSecond > 0, bytesTransferred > 0 else {
      return
    }

    let minimumDurationMs = ceil((Double(bytesTransferred) / Double(maxBytesPerSecond)) * 1000)
    let elapsedMs = (CACurrentMediaTime() - startedAt) * 1000
    let remainingMs = minimumDurationMs - elapsedMs
    if remainingMs > 0 {
      Thread.sleep(forTimeInterval: remainingMs / 1000)
    }
  }
}

private final class DownloadTaskProgress {
  private let lock = NSLock()
  private(set) var bytesTransferred: Int64 = 0
  private(set) var diskWriteDurationMs: Double = 0
  private(set) var requestDurationMs: Double = 0
  let startedAtMs: Double = Date().timeIntervalSince1970 * 1000
  let taskId: String
  let totalBytes: Int64

  init(taskId: String, totalBytes: Int64) {
    self.taskId = taskId
    self.totalBytes = totalBytes
  }

  func add(bytes: Int64, requestDurationMs: Double, diskWriteDurationMs: Double) {
    lock.lock()
    bytesTransferred += bytes
    self.requestDurationMs += requestDurationMs
    self.diskWriteDurationMs += diskWriteDurationMs
    lock.unlock()
  }

  func snapshot() -> [String: Any] {
    lock.lock()
    defer {
      lock.unlock()
    }
    return [
      "taskId": taskId,
      "bytesTransferred": Double(bytesTransferred),
      "totalBytes": Double(totalBytes),
      "requestDurationMs": requestDurationMs,
      "diskWriteDurationMs": diskWriteDurationMs,
      "startedAtMs": startedAtMs,
      "usedNative": true
    ]
  }
}

private actor ChunkAllocator {
  private var nextChunkIndex = 0
  private let totalChunkCount: Int

  init(totalChunkCount: Int) {
    self.totalChunkCount = totalChunkCount
  }

  func next() -> Int? {
    guard nextChunkIndex < totalChunkCount else {
      return nil
    }
    let current = nextChunkIndex
    nextChunkIndex += 1
    return current
  }
}

private actor FileWriter {
  private let handle: FileHandle

  init(url: URL, totalBytes: Int64) throws {
    let fileManager = FileManager.default
    fileManager.createFile(atPath: url.path, contents: Data())
    self.handle = try FileHandle(forWritingTo: url)
    try self.handle.truncate(atOffset: UInt64(totalBytes))
  }

  func write(data: Data, at offset: UInt64) throws -> Double {
    let startedAt = CACurrentMediaTime()
    try handle.seek(toOffset: offset)
    try handle.write(contentsOf: data)
    return (CACurrentMediaTime() - startedAt) * 1000
  }

  func close() throws {
    try handle.close()
  }
}

private final class StreamingDataTaskDelegate: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
  let chunks: AsyncThrowingStream<Data, Error>
  private let chunksContinuation: AsyncThrowingStream<Data, Error>.Continuation
  private let lock = NSLock()
  private var responseContinuation: CheckedContinuation<HTTPURLResponse, Error>?
  private var responseResult: Result<HTTPURLResponse, Error>?

  override init() {
    var continuation: AsyncThrowingStream<Data, Error>.Continuation?
    self.chunks = AsyncThrowingStream<Data, Error> { streamContinuation in
      continuation = streamContinuation
    }
    self.chunksContinuation = continuation!
    super.init()
  }

  func waitForResponse() async throws -> HTTPURLResponse {
    try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      if let responseResult {
        lock.unlock()
        continuation.resume(with: responseResult)
        return
      }

      responseContinuation = continuation
      lock.unlock()
    }
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let httpResponse = response as? HTTPURLResponse else {
      let error = Exception(
        name: "DirectTransferInvalidResponse",
        description: "The sender returned an invalid response.",
        code: "ERR_DIRECT_TRANSFER_DOWNLOAD"
      )
      resolveResponse(.failure(error))
      chunksContinuation.finish(throwing: error)
      completionHandler(.cancel)
      return
    }

    resolveResponse(.success(httpResponse))
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if !data.isEmpty {
      chunksContinuation.yield(data)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error {
      resolveResponse(.failure(error))
      chunksContinuation.finish(throwing: error)
      return
    }

    if !hasResolvedResponse() {
      let responseError = Exception(
        name: "DirectTransferMissingResponse",
        description: "The sender closed the connection before returning file headers.",
        code: "ERR_DIRECT_TRANSFER_DOWNLOAD"
      )
      resolveResponse(.failure(responseError))
      chunksContinuation.finish(throwing: responseError)
      return
    }

    chunksContinuation.finish()
  }

  private func hasResolvedResponse() -> Bool {
    lock.lock()
    defer {
      lock.unlock()
    }

    return responseResult != nil
  }

  private func resolveResponse(_ result: Result<HTTPURLResponse, Error>) {
    let continuation: CheckedContinuation<HTTPURLResponse, Error>?

    lock.lock()
    if responseResult == nil {
      responseResult = result
    }
    continuation = responseContinuation
    responseContinuation = nil
    let resolvedResult = responseResult!
    lock.unlock()

    continuation?.resume(with: resolvedResult)
  }
}

public final class DirectTransferNativeModule: Module {
  private let stateQueue = DispatchQueue(label: "DirectTransferNative.State")
  private lazy var payloadServer = PayloadServer(
    resolveSession: { [weak self] sessionId in
      self?.stateQueue.sync {
        self?.payloadSessions[sessionId]
      }
    },
    appendMetric: { [weak self] sessionId, metric in
      self?.stateQueue.async {
        self?.payloadMetrics[sessionId, default: []].append(metric)
      }
    }
  )
  private var payloadMetrics: [String: [PayloadMetric]] = [:]
  private var payloadSessions: [String: PayloadSession] = [:]
  private var downloadTasks: [String: Task<[String: Any], Error>] = [:]
  private var downloadProgress: [String: DownloadTaskProgress] = [:]

  public func definition() -> ModuleDefinition {
    Name("DirectTransferNative")

    AsyncFunction("ensurePayloadServerStarted") { (promise: Promise) in
      Task {
        do {
          let port = try await self.payloadServer.ensureStarted()
          promise.resolve([
            "port": Double(port)
          ])
        } catch {
          let exception = Exception(
            name: "DirectTransferPayloadServerStartException",
            description: error.localizedDescription,
            code: "ERR_DIRECT_TRANSFER_SERVER_START"
          )
          exception.cause = error
          promise.reject(exception)
        }
      }
    }

    AsyncFunction("stopPayloadServer") {
      payloadServer.stop()
    }

    AsyncFunction("registerPayloadSession") { (options: [String: Any]) in
      let sessionId = try requiredString(options, key: "sessionId")
      let token = try requiredString(options, key: "token")
      let maxBytesPerSecond = optionalInt64(options["maxBytesPerSecond"])
      let files = try requiredFiles(options, key: "files")

      logDirectTransferNativeDebug("Registering native payload session", details: [
        "sessionId": getSessionDebugId(sessionId),
        "fileCount": files.count,
        "maxBytesPerSecond": maxBytesPerSecond ?? 0,
        "tokenSuffix": getTokenDebugSuffix(token),
      ])

      stateQueue.sync {
        payloadSessions[sessionId] = PayloadSession(
          filesById: Dictionary(uniqueKeysWithValues: files.map { ($0.id, $0) }),
          maxBytesPerSecond: maxBytesPerSecond,
          sessionId: sessionId,
          token: token
        )
      }
    }

    AsyncFunction("unregisterPayloadSession") { (sessionId: String) in
      logDirectTransferNativeDebug("Unregistering native payload session", details: [
        "sessionId": getSessionDebugId(sessionId)
      ])
      stateQueue.sync {
        payloadSessions.removeValue(forKey: sessionId)
      }
    }

    AsyncFunction("collectPayloadMetrics") { (sessionId: String) -> [[String: Any]] in
      stateQueue.sync {
        let metrics = payloadMetrics.removeValue(forKey: sessionId) ?? []
        return metrics.map(\.dictionary)
      }
    }

    AsyncFunction("startRangeDownload") { (options: [String: Any], promise: Promise) in
      do {
        let taskId = try requiredString(options, key: "taskId")
        let url = try requiredString(options, key: "url")
        let destinationUri = try requiredString(options, key: "destinationUri")
        let headers = try requiredStringMap(options, key: "headers")
        let totalBytes = try requiredInt64(options, key: "totalBytes")
        let chunkBytes = try requiredInt(options, key: "chunkBytes")
        let maxConcurrentChunks = try requiredInt(options, key: "maxConcurrentChunks")
        let maxBytesPerSecond = optionalInt64(options["maxBytesPerSecond"])
        let progress = DownloadTaskProgress(taskId: taskId, totalBytes: totalBytes)
        let urlValue = URL(string: url)

        logDirectTransferNativeDebug("Starting native range download", details: [
          "taskId": getSessionDebugId(taskId),
          "totalBytes": totalBytes,
          "chunkBytes": chunkBytes,
          "maxConcurrentChunks": maxConcurrentChunks,
          "destinationUri": destinationUri,
          "tokenHeaderSuffix": getTokenDebugSuffix(headers["x-direct-token"] ?? ""),
          "host": urlValue?.host ?? "",
          "port": urlValue?.port ?? (urlValue?.scheme == "https" ? 443 : 80),
          "path": urlValue?.path ?? url,
        ])

        stateQueue.sync {
          downloadProgress[taskId] = progress
        }

        let task = Task.detached(priority: .userInitiated) { [weak self] () throws -> [String: Any] in
          guard let self else {
            throw CancellationError()
          }
          defer {
            self.stateQueue.sync {
              self.downloadTasks.removeValue(forKey: taskId)
              self.downloadProgress.removeValue(forKey: taskId)
            }
          }
          return try await self.runRangeDownload(
            taskId: taskId,
            url: url,
            destinationUri: destinationUri,
            headers: headers,
            totalBytes: totalBytes,
            chunkBytes: chunkBytes,
            maxConcurrentChunks: maxConcurrentChunks,
            maxBytesPerSecond: maxBytesPerSecond,
            progress: progress
          )
        }

        stateQueue.sync {
          downloadTasks[taskId] = task
        }

        Task {
          do {
            let result = try await task.value
            logDirectTransferNativeDebug("Native range download completed", details: [
              "taskId": getSessionDebugId(taskId),
              "bytesTransferred": result["bytesTransferred"] as? Double ?? 0,
              "totalBytes": result["totalBytes"] as? Double ?? 0,
            ])
            promise.resolve(result)
          } catch is CancellationError {
            logDirectTransferNativeDebug("Native range download canceled", details: [
              "taskId": getSessionDebugId(taskId)
            ])
            let exception = Exception(
              name: "DirectTransferDownloadCanceledException",
              description: "Download canceled.",
              code: "ERR_DIRECT_TRANSFER_DOWNLOAD"
            )
            promise.reject(exception)
          } catch {
            logDirectTransferNativeDebug("Native range download failed", details: [
              "taskId": getSessionDebugId(taskId),
              "error": error.localizedDescription
            ])
            let exception = Exception(
              name: "DirectTransferDownloadException",
              description: error.localizedDescription,
              code: "ERR_DIRECT_TRANSFER_DOWNLOAD"
            )
            exception.cause = error
            promise.reject(exception)
          }
        }
      } catch let exception as Exception {
        logDirectTransferNativeDebug("Native range download setup rejected", details: [
          "error": exception.localizedDescription
        ])
        promise.reject(exception)
      } catch {
        logDirectTransferNativeDebug("Native range download setup failed", details: [
          "error": error.localizedDescription
        ])
        let exception = Exception(
          name: "DirectTransferDownloadStartException",
          description: error.localizedDescription,
          code: "ERR_DIRECT_TRANSFER_DOWNLOAD_START"
        )
        exception.cause = error
        promise.reject(exception)
      }
    }

    AsyncFunction("getRangeDownloadProgress") { (taskId: String) -> [String: Any]? in
      stateQueue.sync {
        downloadProgress[taskId]?.snapshot()
      }
    }

    AsyncFunction("cancelRangeDownload") { (taskId: String) in
      stateQueue.sync {
        downloadTasks[taskId]?.cancel()
      }
    }

    OnDestroy {
      payloadServer.stop()
      stateQueue.sync {
        downloadTasks.values.forEach { task in
          task.cancel()
        }
        downloadTasks.removeAll()
        downloadProgress.removeAll()
      }
    }
  }

  private func runRangeDownload(
    taskId: String,
    url: String,
    destinationUri: String,
    headers: [String: String],
    totalBytes: Int64,
    chunkBytes: Int,
    maxConcurrentChunks: Int,
    maxBytesPerSecond: Int64?,
    progress: DownloadTaskProgress
  ) async throws -> [String: Any] {
    let destinationUrl = try requireFileUrl(destinationUri)
    try FileManager.default.createDirectory(
      at: destinationUrl.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )

    logDirectTransferNativeDebug("Initializing native range download task", details: [
      "taskId": getSessionDebugId(taskId),
      "destinationPath": destinationUrl.path,
      "totalBytes": totalBytes,
      "chunkBytes": chunkBytes,
      "maxConcurrentChunks": maxConcurrentChunks,
    ])

    let writer = try FileWriter(url: destinationUrl, totalBytes: totalBytes)
    do {
      let totalChunkCount = Int(ceil(Double(totalBytes) / Double(chunkBytes)))
      let allocator = ChunkAllocator(totalChunkCount: totalChunkCount)

      try await withThrowingTaskGroup(of: Void.self) { group in
        for _ in 0..<max(maxConcurrentChunks, 1) {
          group.addTask {
            while let chunkIndex = await allocator.next() {
              try Task.checkCancellation()
              let start = Int64(chunkIndex * chunkBytes)
              let end = min(start + Int64(chunkBytes) - 1, totalBytes - 1)
              try await self.downloadChunk(
                url: url,
                headers: headers,
                start: start,
                end: end,
                totalBytes: totalBytes,
                maxBytesPerSecond: maxBytesPerSecond,
                writer: writer,
                progress: progress
              )
            }
          }
        }

        try await group.waitForAll()
      }

      var result = progress.snapshot()
      result["completedAtMs"] = Date().timeIntervalSince1970 * 1000
      try await writer.close()
      logDirectTransferNativeDebug("Native range download task finished", details: [
        "taskId": getSessionDebugId(taskId),
        "totalChunkCount": totalChunkCount,
      ])
      return result
    } catch {
      try? await writer.close()
      logDirectTransferNativeDebug("Native range download task threw", details: [
        "taskId": getSessionDebugId(taskId),
        "error": error.localizedDescription
      ])
      throw error
    }
  }

  private func downloadChunk(
    url: String,
    headers: [String: String],
    start: Int64,
    end: Int64,
    totalBytes: Int64,
    maxBytesPerSecond: Int64?,
    writer: FileWriter,
    progress: DownloadTaskProgress
  ) async throws {
    guard let requestUrl = URL(string: url) else {
      throw Exception(name: "DirectTransferInvalidUrl", description: "Invalid direct download URL.", code: "ERR_DIRECT_TRANSFER_DOWNLOAD")
    }

    var request = URLRequest(url: requestUrl)
    request.httpMethod = "GET"
    request.timeoutInterval = 30
    request.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")
    headers.forEach { key, value in
      request.setValue(value, forHTTPHeaderField: key)
    }

    let delegate = StreamingDataTaskDelegate()
    let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
    let dataTask = session.dataTask(with: request)
    let requestStartedAt = CACurrentMediaTime()
    let expectedChunkBytes = end - start + 1

    try await withTaskCancellationHandler(operation: {
      do {
        logDirectTransferNativeDebug("Starting native chunk request", details: [
          "taskId": getSessionDebugId(progress.taskId),
          "rangeStart": start,
          "rangeEnd": end,
          "expectedChunkBytes": expectedChunkBytes,
        ].merging(getUrlDebugDetails(requestUrl)) { _, new in new })

        defer {
          session.finishTasksAndInvalidate()
        }

        dataTask.resume()

        let httpResponse = try await delegate.waitForResponse()
        logDirectTransferNativeDebug("Native chunk response received", details: [
          "taskId": getSessionDebugId(progress.taskId),
          "statusCode": httpResponse.statusCode,
          "contentRange": httpResponse.value(forHTTPHeaderField: "Content-Range") ?? "",
        ].merging(getUrlDebugDetails(requestUrl)) { _, new in new })
        guard httpResponse.statusCode == 206 else {
          throw Exception(name: "DirectTransferBadStatus", description: "Unable to download file chunk.", code: "ERR_DIRECT_TRANSFER_DOWNLOAD")
        }

        guard let contentRange = parseContentRange(httpResponse.value(forHTTPHeaderField: "Content-Range")),
              contentRange.start == start,
              contentRange.end == end,
              contentRange.total == nil || contentRange.total == totalBytes
        else {
          throw Exception(name: "DirectTransferBadRange", description: "The sender returned an unexpected file chunk.", code: "ERR_DIRECT_TRANSFER_DOWNLOAD")
        }

        var bytesDownloaded: Int64 = 0
        var nextOffset = UInt64(start)
        var pendingData = Data()
        pendingData.reserveCapacity(ioPageBytes)

        func flushPendingData() async throws {
          guard !pendingData.isEmpty else {
            return
          }

          let writeOffset = nextOffset
          let bytesToWrite = pendingData
          pendingData = Data()
          pendingData.reserveCapacity(ioPageBytes)
          nextOffset += UInt64(bytesToWrite.count)

          let diskWriteDurationMs = try await writer.write(data: bytesToWrite, at: writeOffset)
          progress.add(
            bytes: Int64(bytesToWrite.count),
            requestDurationMs: 0,
            diskWriteDurationMs: diskWriteDurationMs
          )

          throttleChunk(
            bytesTransferred: bytesDownloaded,
            maxBytesPerSecond: maxBytesPerSecond,
            startedAt: requestStartedAt
          )
        }

        for try await data in delegate.chunks {
          try Task.checkCancellation()
          if data.isEmpty {
            continue
          }

          let remainingChunkBytes = expectedChunkBytes - bytesDownloaded
          if Int64(data.count) > remainingChunkBytes {
            throw Exception(
              name: "DirectTransferTooManyBytes",
              description: "The sender returned too many bytes for this file chunk.",
              code: "ERR_DIRECT_TRANSFER_DOWNLOAD"
            )
          }

          pendingData.append(data)
          bytesDownloaded += Int64(data.count)

          if pendingData.count >= ioPageBytes {
            try await flushPendingData()
          }
        }

        try await flushPendingData()

        guard bytesDownloaded == expectedChunkBytes else {
          throw Exception(
            name: "DirectTransferIncompleteChunk",
            description: "The sender returned an incomplete file chunk.",
            code: "ERR_DIRECT_TRANSFER_DOWNLOAD"
          )
        }

        progress.add(
          bytes: 0,
          requestDurationMs: (CACurrentMediaTime() - requestStartedAt) * 1000,
          diskWriteDurationMs: 0
        )
        logDirectTransferNativeDebug("Native chunk completed", details: [
          "taskId": getSessionDebugId(progress.taskId),
          "rangeStart": start,
          "rangeEnd": end,
          "bytesDownloaded": bytesDownloaded,
        ])
      } catch {
        logDirectTransferNativeDebug("Native chunk request failed", details: [
          "taskId": getSessionDebugId(progress.taskId),
          "rangeStart": start,
          "rangeEnd": end,
          "error": error.localizedDescription,
        ].merging(getUrlDebugDetails(requestUrl)) { _, new in new })
        throw error
      }
    }, onCancel: {
      logDirectTransferNativeDebug("Canceling native chunk request", details: [
        "taskId": getSessionDebugId(progress.taskId),
        "rangeStart": start,
        "rangeEnd": end,
      ])
      dataTask.cancel()
      session.invalidateAndCancel()
    })
  }

  private func parseContentRange(_ value: String?) -> ParsedRange? {
    guard let value, !value.isEmpty else {
      return nil
    }

    let pattern = try? NSRegularExpression(pattern: "^bytes (\\d+)-(\\d+)/(\\d+|\\*)$", options: [.caseInsensitive])
    let nsRange = NSRange(location: 0, length: value.utf16.count)
    guard let match = pattern?.firstMatch(in: value.trimmingCharacters(in: .whitespacesAndNewlines), options: [], range: nsRange),
          let startRange = Range(match.range(at: 1), in: value),
          let endRange = Range(match.range(at: 2), in: value)
    else {
      return nil
    }

    let totalRange = Range(match.range(at: 3), in: value)
    return ParsedRange(
      end: Int64(value[endRange]) ?? 0,
      partial: true,
      start: Int64(value[startRange]) ?? 0,
      total: totalRange.flatMap { range in
        let raw = String(value[range])
        return raw == "*" ? nil : Int64(raw)
      }
    )
  }

  private func throttleChunk(bytesTransferred: Int64, maxBytesPerSecond: Int64?, startedAt: CFTimeInterval) {
    guard let maxBytesPerSecond, maxBytesPerSecond > 0, bytesTransferred > 0 else {
      return
    }

    let minimumDurationMs = ceil((Double(bytesTransferred) / Double(maxBytesPerSecond)) * 1000)
    let elapsedMs = (CACurrentMediaTime() - startedAt) * 1000
    let remainingMs = minimumDurationMs - elapsedMs
    if remainingMs > 0 {
      Thread.sleep(forTimeInterval: remainingMs / 1000)
    }
  }

  private func requiredString(_ options: [String: Any], key: String) throws -> String {
    guard let value = options[key] as? String else {
      throw Exception(name: "DirectTransferMissingOption", description: "Missing \"\(key)\".", code: "ERR_DIRECT_TRANSFER_OPTION")
    }
    return value
  }

  private func requiredInt(_ options: [String: Any], key: String) throws -> Int {
    guard let value = options[key] else {
      throw Exception(name: "DirectTransferMissingOption", description: "Missing \"\(key)\".", code: "ERR_DIRECT_TRANSFER_OPTION")
    }
    if let intValue = value as? Int {
      return intValue
    }
    if let doubleValue = value as? Double {
      return Int(doubleValue)
    }
    throw Exception(name: "DirectTransferInvalidOption", description: "Invalid \"\(key)\".", code: "ERR_DIRECT_TRANSFER_OPTION")
  }

  private func requiredInt64(_ options: [String: Any], key: String) throws -> Int64 {
    guard let value = options[key] else {
      throw Exception(name: "DirectTransferMissingOption", description: "Missing \"\(key)\".", code: "ERR_DIRECT_TRANSFER_OPTION")
    }
    if let intValue = value as? Int {
      return Int64(intValue)
    }
    if let int64Value = value as? Int64 {
      return int64Value
    }
    if let doubleValue = value as? Double {
      return Int64(doubleValue)
    }
    throw Exception(name: "DirectTransferInvalidOption", description: "Invalid \"\(key)\".", code: "ERR_DIRECT_TRANSFER_OPTION")
  }

  private func optionalInt64(_ value: Any?) -> Int64? {
    if let intValue = value as? Int {
      return Int64(intValue)
    }
    if let int64Value = value as? Int64 {
      return int64Value
    }
    if let doubleValue = value as? Double {
      return Int64(doubleValue)
    }
    return nil
  }

  private func requiredStringMap(_ options: [String: Any], key: String) throws -> [String: String] {
    guard let value = options[key] as? [String: String] else {
      return [:]
    }
    return value
  }

  private func requiredFiles(_ options: [String: Any], key: String) throws -> [PayloadFile] {
    guard let values = options[key] as? [[String: Any]] else {
      throw Exception(name: "DirectTransferMissingOption", description: "Missing \"\(key)\".", code: "ERR_DIRECT_TRANSFER_OPTION")
    }

    return try values.map { value in
      PayloadFile(
        id: try requiredString(value, key: "id"),
        mimeType: (value["mimeType"] as? String) ?? "",
        sizeBytes: optionalInt64(value["sizeBytes"]) ?? 0,
        uri: try requiredString(value, key: "uri")
      )
    }
  }

  private func requireFileUrl(_ uri: String) throws -> URL {
    if uri.hasPrefix("file://"), let url = URL(string: uri) {
      return url
    }
    if uri.contains("://") {
      throw Exception(name: "DirectTransferInvalidUri", description: "Only file:// URIs are supported for direct transfer.", code: "ERR_DIRECT_TRANSFER_URI")
    }
    return URL(fileURLWithPath: uri)
  }
}
