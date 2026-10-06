package uz.nexus.logistika.driver

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Ekran o‘chiq bo‘lsa ham har daqiqada serverga joylashuv/signal yuboradi. */
class TrackingService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var locationManager: LocationManager? = null
    private var last: Location? = null
    private val beat = object : Runnable {
        override fun run() {
            sendBeat()
            handler.postDelayed(this, BEAT_MS)
        }
    }
    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            val prev = last
            if (prev == null || location.time >= prev.time) last = location
        }

        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startInForeground()
        startLocation()
        handler.removeCallbacks(beat)
        handler.post(beat)
        return START_STICKY
    }

    private fun startInForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Joylashuv kuzatuvi", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Nexus Haydovchi")
            .setContentText("Joylashuv dispetcherga yuborilmoqda")
            .setSmallIcon(R.drawable.ic_stat_nexus)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    @SuppressLint("MissingPermission")
    private fun startLocation() {
        if (!hasLocation()) return
        val lm = locationManager ?: (getSystemService(Context.LOCATION_SERVICE) as LocationManager).also {
            locationManager = it
        }
        lm.removeUpdates(listener)
        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).forEach { p ->
            try {
                if (lm.isProviderEnabled(p)) {
                    lm.requestLocationUpdates(p, 30_000L, 10f, listener, Looper.getMainLooper())
                    lm.getLastKnownLocation(p)?.let { listener.onLocationChanged(it) }
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun hasLocation(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun sendBeat() {
        val prefs = getSharedPreferences("nexus", MODE_PRIVATE)
        val token = prefs.getString("drv_token", "").orEmpty()
        val base = prefs.getString("last_ok_url", "").orEmpty().removeSuffix("/").removeSuffix("/driver")
        if (token.isBlank() || base.isBlank()) return
        val loc = last
        val points = JSONArray()
        if (loc != null && System.currentTimeMillis() - loc.time < 5 * 60_000L) {
            points.put(
                JSONObject()
                    .put("lat", loc.latitude)
                    .put("lng", loc.longitude)
                    .put("heading", if (loc.hasBearing()) loc.bearing.toDouble() else 0.0)
                    .put("accuracy", if (loc.hasAccuracy()) loc.accuracy.toDouble() else 0.0)
                    .put("speed", if (loc.hasSpeed()) loc.speed.toDouble() else 0.0)
                    .put("recorded_at", iso(Date(loc.time)))
                    .put("offline", false),
            )
        }
        val body = JSONObject().put("points", points).toString()
        Thread {
            try {
                val c = URL("$base/api/driver/location").openConnection() as HttpURLConnection
                c.connectTimeout = 8000
                c.readTimeout = 8000
                c.requestMethod = "POST"
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.setRequestProperty("Authorization", "Bearer $token")
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val code = c.responseCode
                c.disconnect()
                if (code == 401) {
                    prefs.edit().remove("drv_token").apply()
                    handler.post { stopSelf() }
                }
            } catch (_: Exception) {
            }
        }.start()
    }

    private fun iso(d: Date): String {
        val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return f.format(d)
    }

    override fun onDestroy() {
        handler.removeCallbacks(beat)
        try {
            locationManager?.removeUpdates(listener)
        } catch (_: Exception) {
        }
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "uz.nexus.logistika.driver.STOP_TRACKING"
        private const val CHANNEL = "nexus_tracking"
        private const val NOTIF_ID = 42
        private const val BEAT_MS = 60_000L
    }
}
