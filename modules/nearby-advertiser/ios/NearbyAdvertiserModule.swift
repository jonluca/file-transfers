import ExpoModulesCore
import Foundation

private final class PublishedNearbyService: NSObject, NetServiceDelegate {
  let service: NetService
  var onPublished: ((String) -> Void)?
  var onFailure: ((Error) -> Void)?

  init(service: NetService) {
    self.service = service
  }

  func netServiceDidPublish(_ sender: NetService) {
    onPublished?(sender.name)
  }

  func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
    let code = errorDict[NetService.errorCode]?.intValue ?? -1
    let error = NSError(
      domain: NetService.errorDomain,
      code: code,
      userInfo: [
        NSLocalizedDescriptionKey: "Failed to advertise nearby service \"\(sender.name)\"."
      ]
    )
    onFailure?(error)
  }
}

public class NearbyAdvertiserModule: Module {
  private var services: [String: PublishedNearbyService] = [:]

  public func definition() -> ModuleDefinition {
    Name("NearbyAdvertiser")

    AsyncFunction("startAdvertising") { (serviceName: String, type: String, domain: String, port: Int, promise: Promise) in
      self.stopPublishedService(named: serviceName)

      let service = NetService(
        domain: Self.normalizedDomain(domain),
        type: Self.normalizedType(type),
        name: serviceName,
        port: Int32(port)
      )
      service.includesPeerToPeer = true

      let publishedService = PublishedNearbyService(service: service)
      publishedService.onPublished = { actualServiceName in
        self.replaceStoredService(originalName: serviceName, actualName: actualServiceName, service: publishedService)
        promise.resolve([
          "serviceName": actualServiceName
        ])
      }
      publishedService.onFailure = { error in
        self.stopPublishedService(named: serviceName)
        let exception = Exception(
          name: "NearbyAdvertiseStartException",
          description: error.localizedDescription,
          code: "ERR_NEARBY_ADVERTISE_START"
        )
        exception.cause = error
        promise.reject(exception)
      }

      services[serviceName] = publishedService
      service.delegate = publishedService
      service.publish()
    }
    .runOnQueue(.main)

    AsyncFunction("stopAdvertising") { (serviceName: String) in
      self.stopPublishedService(named: serviceName)
    }
    .runOnQueue(.main)

    OnDestroy {
      self.stopAllPublishedServices()
    }
  }

  private func replaceStoredService(originalName: String, actualName: String, service: PublishedNearbyService) {
    services[originalName] = nil
    services[actualName] = service
  }

  private func stopPublishedService(named serviceName: String) {
    let matchKey =
      services[serviceName] != nil
      ? serviceName
      : services.first(where: { $0.value.service.name == serviceName })?.key

    guard let matchKey, let publishedService = services.removeValue(forKey: matchKey) else {
      return
    }

    publishedService.service.delegate = nil
    publishedService.service.stop()
  }

  private func stopAllPublishedServices() {
    let serviceNames = Array(services.keys)
    for serviceName in serviceNames {
      stopPublishedService(named: serviceName)
    }
  }

  private static func normalizedType(_ value: String) -> String {
    var normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if !normalized.hasPrefix("_") {
      normalized = "_\(normalized)"
    }
    if !normalized.hasSuffix(".") {
      normalized += "."
    }
    return normalized
  }

  private static func normalizedDomain(_ value: String) -> String {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else {
      return "local."
    }
    return normalized.hasSuffix(".") ? normalized : "\(normalized)."
  }
}
