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
import androidx.core.app.NotificationManagerCompat
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
        val prefs = getSharedPreferences("nexus", MODE_PRIVATE)
        // Tizim xizmatni o‘zi qayta tiklaganda (intent == null): ilova yopilgan yoki chiqilgan bo‘lsa ishlamaydi
        if (intent?.action == ACTION_STOP || (intent == null && !prefs.getBoolean(PREF_ON, false))) {
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            startInForeground()
        } catch (_: Exception) {
            stopSelf()
            return START_NOT_STICKY
        }
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
            .setContentText("Joylashuv dispetcherga yuborilmoqda — ilova to‘liq yopilganda to‘xtaydi")
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
        // O‘chiq provayderga ham obuna bo‘linadi: haydovchi GPS'ni keyin yoqsa, nuqtalar o‘zi kela boshlaydi
        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).filter { it in lm.allProviders }.forEach { p ->
            try {
                lm.requestLocationUpdates(p, 30_000L, 10f, listener, Looper.getMainLooper())
                lm.getLastKnownLocation(p)?.let { listener.onLocationChanged(it) }
            } catch (_: Exception) {
            }
        }
    }

    // Ilova "so‘nggi ilovalar" ro‘yxatidan surib yopilganda kuzatuv to‘xtaydi
    override fun onTaskRemoved(rootIntent: Intent?) {
        getSharedPreferences("nexus", MODE_PRIVATE).edit().putBoolean(PREF_ON, false).apply()
        stopSelf()
        super.onTaskRemoved(rootIntent)
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
                val c = URL("$base/api/driver/location?reys=true").openConnection() as HttpURLConnection
                c.connectTimeout = 8000
                c.readTimeout = 8000
                c.requestMethod = "POST"
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.setRequestProperty("Authorization", "Bearer $token")
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val code = c.responseCode
                val reply = if (code in 200..299) c.inputStream.bufferedReader().use { it.readText() } else ""
                c.disconnect()
                if (code == 401) {
                    prefs.edit().remove("drv_token").putBoolean(PREF_ON, false).apply()
                    handler.post { stopSelf() }
                }
                if (reply.isNotEmpty()) {
                    JSONObject(reply).optJSONArray("reys")?.let { checkNewReys(it, token) }
                }
            } catch (_: Exception) {
            }
        }.start()
    }

    /**
     * Serverdagi faol reyslar oldingi ro‘yxat bilan solishtiriladi; yangisi bo‘lsa va ilova ekranda bo‘lmasa — bildirishnoma.
     * Har yangi kirishdagi (yangi token) birinchi ro‘yxat faqat boshlang‘ich nuqta bo‘ladi.
     */
    private fun checkNewReys(list: JSONArray, token: String) {
        val prefs = getSharedPreferences("nexus", MODE_PRIVATE)
        val items = (0 until list.length()).mapNotNull { list.optJSONObject(it) }.filter { it.optString("key").isNotEmpty() }
        val keys = items.map { it.optString("key") }
        val tokenTag = token.takeLast(16)
        val baseline = prefs.getString(PREF_REYS_TOKEN, "") != tokenTag
        val seen = if (baseline) emptySet() else
            prefs.getString(PREF_REYS_SEEN, "[]").orEmpty().let { raw ->
                try {
                    JSONArray(raw).let { a -> (0 until a.length()).map { a.optString(it) }.toSet() }
                } catch (_: Exception) {
                    emptySet()
                }
            }
        prefs.edit().putString(PREF_REYS_TOKEN, tokenTag).putString(PREF_REYS_SEEN, JSONArray(keys).toString()).apply()
        if (baseline || MainActivity.visible) return
        items.filter { it.optString("key") !in seen }.forEach { showReysNotice(it) }
    }

    private fun showReysNotice(item: JSONObject) {
        val nmc = NotificationManagerCompat.from(this)
        if (!nmc.areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(REYS_CHANNEL, "Yangi reyslar", NotificationManager.IMPORTANCE_HIGH)
            ch.description = "Sizga yangi reys biriktirilganda xabar beradi"
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
        }
        val key = item.optString("key")
        val code = item.optString("route_code").trim().ifEmpty { "Reys" }
        val count = item.optInt("count", 0)
        val text = "${dayLabel(item.optString("delivery_date"))} · $count ta zayavka"
        val open = PendingIntent.getActivity(
            this,
            REYS_REQUEST,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(MainActivity.EXTRA_NOTICES, true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(this, REYS_CHANNEL)
            .setContentTitle("Yangi reys: $code")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_nexus)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        try {
            nmc.notify(REYS_NOTIF_BASE + (key.hashCode() and 0xFFFF), n)
        } catch (_: SecurityException) {
        }
    }

    private fun dayLabel(raw: String): String {
        val day = raw.take(10)
        if (!Regex("""\d{4}-\d{2}-\d{2}""").matches(day)) return "Sanasiz"
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        val now = Date()
        if (day == f.format(now)) return "Bugun"
        if (day == f.format(Date(now.time + 86_400_000L))) return "Ertaga"
        return "${day.substring(8, 10)}.${day.substring(5, 7)}"
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
        const val PREF_ON = "track_on"
        private const val CHANNEL = "nexus_tracking"
        private const val NOTIF_ID = 42
        private const val BEAT_MS = 60_000L
        private const val REYS_CHANNEL = "nexus_reys"
        private const val REYS_REQUEST = 7
        private const val REYS_NOTIF_BASE = 10_000
        private const val PREF_REYS_SEEN = "reys_seen"
        private const val PREF_REYS_TOKEN = "reys_seen_tok"
    }
}
