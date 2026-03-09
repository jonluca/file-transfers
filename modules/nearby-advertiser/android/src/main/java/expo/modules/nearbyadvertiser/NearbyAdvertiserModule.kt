package expo.modules.nearbyadvertiser

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NearbyAdvertiserModule : Module() {
  private data class ActiveRegistration(
    val serviceInfo: NsdServiceInfo,
    val listener: NsdManager.RegistrationListener,
  )

  private val registrations = mutableMapOf<String, ActiveRegistration>()

  override fun definition() = ModuleDefinition {
    Name("NearbyAdvertiser")

    AsyncFunction("startAdvertising") { serviceName: String, type: String, _: String, port: Int, promise: Promise ->
      val nsdManager = getNsdManager()
      stopRegistration(nsdManager, serviceName)

      val serviceInfo = NsdServiceInfo().apply {
        this.serviceName = serviceName
        serviceType = normalizedType(type)
        setPort(port)
      }

      val listener = object : NsdManager.RegistrationListener {
        override fun onServiceRegistered(registeredServiceInfo: NsdServiceInfo) {
          val actualServiceName = registeredServiceInfo.serviceName
          registrations.remove(serviceName)
          registrations[actualServiceName] = ActiveRegistration(
            serviceInfo = registeredServiceInfo,
            listener = this,
          )
          promise.resolve(
            mapOf(
              "serviceName" to actualServiceName,
            )
          )
        }

        override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
          registrations.remove(serviceName)
          promise.reject(
            "ERR_NEARBY_ADVERTISE_START",
            "Failed to advertise nearby service \"$serviceName\" ($errorCode).",
            null,
          )
        }

        override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {
          registrations.remove(serviceName)
          registrations.remove(serviceInfo.serviceName)
        }

        override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
          registrations.remove(serviceName)
          registrations.remove(serviceInfo.serviceName)
        }
      }

      registrations[serviceName] = ActiveRegistration(
        serviceInfo = serviceInfo,
        listener = listener,
      )
      nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, listener)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopAdvertising") { serviceName: String ->
      stopRegistration(getNsdManager(), serviceName)
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      stopAllRegistrations()
    }
  }

  private fun getNsdManager(): NsdManager {
    val context = appContext.reactContext?.applicationContext
      ?: throw IllegalStateException("React context is unavailable.")

    return context.getSystemService(Context.NSD_SERVICE) as? NsdManager
      ?: throw IllegalStateException("Network service discovery is unavailable.")
  }

  private fun stopRegistration(nsdManager: NsdManager, serviceName: String) {
    val registration = removeRegistration(serviceName) ?: return
    runCatching {
      nsdManager.unregisterService(registration.listener)
    }
  }

  private fun stopAllRegistrations() {
    val nsdManager = runCatching { getNsdManager() }.getOrNull() ?: return
    val snapshot = registrations.values.toList()
    registrations.clear()

    snapshot.forEach { registration ->
      runCatching {
        nsdManager.unregisterService(registration.listener)
      }
    }
  }

  private fun removeRegistration(serviceName: String): ActiveRegistration? {
    registrations.remove(serviceName)?.let { return it }

    val matchedKey = registrations.entries.firstOrNull { entry ->
      entry.value.serviceInfo.serviceName == serviceName
    }?.key ?: return null

    return registrations.remove(matchedKey)
  }

  private fun normalizedType(type: String): String {
    var normalized = type.trim()
    if (!normalized.startsWith("_")) {
      normalized = "_$normalized"
    }
    if (!normalized.endsWith(".")) {
      normalized += "."
    }
    return normalized
  }
}
