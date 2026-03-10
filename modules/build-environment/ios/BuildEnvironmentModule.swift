import ExpoModulesCore
import Foundation

public class BuildEnvironmentModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BuildEnvironment")

    Constant("isTestFlight") {
      Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
    }
  }
}
