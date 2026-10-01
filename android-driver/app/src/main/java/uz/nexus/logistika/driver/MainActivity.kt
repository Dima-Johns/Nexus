package uz.nexus.logistika.driver

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.widget.TextView
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.content.FileProvider
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var pendingScan = false
    private var showingError = false
    private val retry = Handler(Looper.getMainLooper())

    private val qrLauncher = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        deliverQr(text)
    }

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var photoUri: Uri? = null
    private var pendingPhoto = false

    private val takePicture = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val cb = fileCallback
        fileCallback = null
        val uri = photoUri
        cb?.onReceiveValue(if (ok && uri != null) arrayOf(uri) else null)
    }

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { granted ->
        val camOk = granted[Manifest.permission.CAMERA] == true || hasCamera()
        if (pendingScan && camOk) {
            pendingScan = false
            launchQr()
        }
        if (pendingPhoto) {
            pendingPhoto = false
            if (camOk) launchCamera() else cancelFileChooser()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        splash = findViewById(R.id.splash)
        splashText = findViewById(R.id.splash_text)
        findViewById<View>(R.id.splash_brand).apply {
            alpha = 0f
            scaleX = 0.9f
            scaleY = 0.9f
            translationY = 24f
            animate().alpha(1f).scaleX(1f).scaleY(1f).translationY(0f)
                .setDuration(750).setInterpolator(DecelerateInterpolator(1.8f)).start()
        }
        web.setBackgroundColor(Color.parseColor("#07080c"))
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.settings.cacheMode = WebSettings.LOAD_NO_CACHE
        web.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        web.settings.setGeolocationEnabled(true)
        web.settings.useWideViewPort = true
        web.settings.loadWithOverviewMode = true
        web.addJavascriptInterface(JsBridge(), "NexusNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (isMapsUri(uri)) {
                    openExternal(uri)
                    return true
                }
                val scheme = uri.scheme ?: ""
                return !(scheme == "http" || scheme == "https")
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (!request.isForMainFrame || showingError) return
                showError()
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (url != null && url.startsWith("http") && url.contains("/driver") && !showingError) {
                    retry.removeCallbacksAndMessages(null)
                    splash.visibility = View.GONE
                    web.visibility = View.VISIBLE
                    prefs().edit().putString("last_ok_url", activeUrl).apply()
                }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback,
            ) {
                callback.invoke(origin, true, false)
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { request.grant(request.resources) }
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                if (hasCamera()) {
                    launchCamera()
                } else {
                    pendingPhoto = true
                    permLauncher.launch(arrayOf(Manifest.permission.CAMERA))
                }
                return true
            }
        }

        askPermissions(scanAfter = false)
        dropStaleLanUrls()
        connect()
    }

    inner class JsBridge {
        @JavascriptInterface
        fun hasNative(): Boolean = true

        @JavascriptInterface
        fun scanQr() {
            runOnUiThread {
                if (hasCamera()) launchQr() else {
                    pendingScan = true
                    askPermissions(scanAfter = true)
                }
            }
        }

        @JavascriptInterface
        fun openRoute(json: String) {
            runOnUiThread { openOrderedRoute(json) }
        }

        @JavascriptInterface
        fun navigate(json: String) {
            runOnUiThread { navigateToPoint(json) }
        }

        @JavascriptInterface
        fun retry() {
            runOnUiThread { connect() }
        }

        @JavascriptInterface
        fun startTracking(token: String) {
            if (token.isBlank()) return
            prefs().edit().putString("drv_token", token).apply()
            runOnUiThread {
                askNotificationPermission()
                val i = Intent(this@MainActivity, TrackingService::class.java)
                try {
                    ContextCompat.startForegroundService(this@MainActivity, i)
                } catch (_: Exception) {
                }
            }
        }

        @JavascriptInterface
        fun stopTracking() {
            prefs().edit().remove("drv_token").apply()
            runOnUiThread {
                stopService(Intent(this@MainActivity, TrackingService::class.java))
            }
        }

        @JavascriptInterface
        fun setServer(raw: String) {
            val url = normalizeUrl(raw)
            runOnUiThread {
                if (url != null) {
                    prefs().edit().putString("manual_url", url).putString("last_ok_url", url).apply()
                    connect()
                } else if (raw.isBlank()) {
                    prefs().edit().remove("manual_url").remove("last_ok_url").apply()
                    connect()
                }
            }
        }
    }

    private lateinit var splash: View
    private lateinit var splashText: TextView
    private var activeUrl: String = ""
    private var connecting = false
    private val probes = Executors.newCachedThreadPool()

    private fun prefs() = getSharedPreferences("nexus", MODE_PRIVATE)

    private fun normalizeUrl(raw: String): String? {
        var s = raw.trim()
        if (s.isEmpty()) return null
        if (!s.startsWith("http://") && !s.startsWith("https://")) {
            val host = s.substringBefore('/').substringBefore(':')
            val lan = host == "localhost" || host.all { it.isDigit() || it == '.' }
            s = (if (lan) "http://" else "https://") + s
        }
        val u = Uri.parse(s)
        val host = u.host
        if (host.isNullOrBlank()) return null
        // Lokal kompyuter (IP) 8000-portda, internetdagi server (masalan Railway) esa standart portda
        val lan = host == "localhost" || host.all { it.isDigit() || it == '.' }
        val port = when {
            u.port > 0 -> ":${u.port}"
            u.scheme == "http" && lan -> ":8000"
            else -> ""
        }
        return "${u.scheme}://$host$port/driver/"
    }

    private fun isLanUrl(url: String): Boolean {
        val host = Uri.parse(url).host ?: return false
        return host == "localhost" || host.all { it.isDigit() || it == '.' }
    }

    // Eski versiyada saqlangan kompyuter (Wi‑Fi) manzillari internetdagi serverdan ustun bo‘lib qolmasin
    private fun dropStaleLanUrls() {
        val p = prefs()
        val version = try {
            PackageInfoCompat.getLongVersionCode(packageManager.getPackageInfo(packageName, 0))
        } catch (_: Exception) {
            0L
        }
        if (p.getLong("cfg_version", 0L) >= version) return
        val e = p.edit()
        listOf("manual_url", "last_ok_url").forEach { key ->
            if (isLanUrl(p.getString(key, "") ?: "")) e.remove(key)
        }
        e.putLong("cfg_version", version).apply()
    }

    // Tartib — ustuvorlik: qo‘lda kiritilgan, standart (Railway), oxirgi ishlagan, zaxira
    private fun serverUrls(): List<String> {
        val list = mutableListOf<String>()
        prefs().getString("manual_url", null)?.takeIf { it.isNotBlank() }?.let { list.add(it) }
        val base = getString(R.string.default_url)
        if (base !in list) list.add(base)
        prefs().getString("last_ok_url", null)?.takeIf { it.isNotBlank() && it !in list }?.let { list.add(it) }
        resources.getStringArray(R.array.fallback_urls).forEach { if (it.isNotBlank() && it !in list) list.add(it) }
        return list
    }

    private fun probe(url: String): Boolean {
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = if (isLanUrl(url)) 2500 else 8000
            c.readTimeout = if (isLanUrl(url)) 2500 else 8000
            c.requestMethod = "GET"
            c.instanceFollowRedirects = true
            val code = c.responseCode
            c.disconnect()
            code in 200..399
        } catch (_: Exception) {
            false
        }
    }

    private fun ownIpv4(): List<Inet4Address> {
        return try {
            NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.toList() }
                .filterIsInstance<Inet4Address>()
                .filter { it.isSiteLocalAddress }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun isNexus(url: String): Boolean {
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = 1500
            c.readTimeout = 2500
            val ok = c.responseCode in 200..299
            val body = if (ok) c.inputStream.bufferedReader().use { it.readText().take(4000) } else ""
            c.disconnect()
            ok && body.contains("Nexus", ignoreCase = true)
        } catch (_: Exception) {
            false
        }
    }

    // Kompyuter IP manzili o‘zgarsa ham serverni topish uchun telefon ulangan /24 tarmoqlarni 8000-portga skanerlaydi
    private fun scanLan(): String? {
        val own = ownIpv4()
        val ownHosts = own.mapNotNull { it.hostAddress }.toSet()
        val hosts = own.mapNotNull { it.hostAddress?.substringBeforeLast('.') }
            .distinct()
            .flatMap { net -> (1..254).map { "$net.$it" } }
            .filter { it !in ownHosts }
        if (hosts.isEmpty()) return null
        val pool = Executors.newFixedThreadPool(48)
        return try {
            val tasks = hosts.map { host ->
                Callable {
                    Socket().use { it.connect(InetSocketAddress(host, 8000), 400) }
                    val url = "http://$host:8000/driver/"
                    if (isNexus(url)) url else throw IllegalStateException("no")
                }
            }
            pool.invokeAny(tasks, 20, TimeUnit.SECONDS)
        } catch (_: Exception) {
            null
        } finally {
            pool.shutdownNow()
        }
    }

    private fun showSplash(text: String) {
        splash.visibility = View.VISIBLE
        splashText.text = text
    }

    private fun connect() {
        if (connecting) return
        connecting = true
        retry.removeCallbacksAndMessages(null)
        showingError = false
        showSplash("Serverga ulanmoqda…")
        val urls = serverUrls()
        Thread {
            var found: String? = null
            try {
                // Hammasi parallel tekshiriladi, lekin javob berganlardan ro‘yxatda birinchisi tanlanadi
                val futures = urls.map { url -> probes.submit(Callable { probe(url) }) }
                val deadline = System.currentTimeMillis() + 10_000
                for ((i, f) in futures.withIndex()) {
                    val left = (deadline - System.currentTimeMillis()).coerceAtLeast(1)
                    val ok = try {
                        f.get(left, TimeUnit.MILLISECONDS)
                    } catch (_: Exception) {
                        false
                    }
                    if (ok) {
                        found = urls[i]
                        break
                    }
                }
                futures.forEach { it.cancel(true) }
            } catch (_: Exception) {
            }
            if (found == null && urls.any { isLanUrl(it) }) {
                runOnUiThread { showSplash("Server Wi‑Fi tarmoqdan qidirilmoqda…") }
                found = scanLan()
                found?.let { prefs().edit().remove("manual_url").putString("last_ok_url", it).apply() }
            }
            val ok = found
            runOnUiThread {
                connecting = false
                if (ok != null) {
                    activeUrl = ok
                    web.visibility = View.VISIBLE
                    web.loadUrl(ok)
                } else {
                    showError()
                }
            }
        }.start()
    }

    private fun loadServer() = connect()

    private fun showError() {
        showingError = true
        splash.visibility = View.GONE
        web.visibility = View.VISIBLE
        web.loadDataWithBaseURL("about:blank", errorHtml(), "text/html", "utf-8", null)
        retry.postDelayed({ connect() }, 5000)
    }

    private fun hasCamera(): Boolean {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    }

    private fun askPermissions(scanAfter: Boolean) {
        pendingScan = scanAfter
        val need = listOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.CAMERA,
        ).filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (need.isEmpty()) {
            if (scanAfter) launchQr()
            return
        }
        permLauncher.launch(need.toTypedArray())
    }

    private fun launchCamera() {
        try {
            val dir = File(cacheDir, "proofs").apply { mkdirs() }
            dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000L }?.forEach { it.delete() }
            val file = File.createTempFile("proof_", ".jpg", dir)
            val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
            photoUri = uri
            takePicture.launch(uri)
        } catch (_: Exception) {
            cancelFileChooser()
        }
    }

    private fun cancelFileChooser() {
        fileCallback?.onReceiveValue(null)
        fileCallback = null
    }

    private fun askNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < 33) return
        val p = Manifest.permission.POST_NOTIFICATIONS
        if (ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED) return
        permLauncher.launch(arrayOf(p))
    }

    private fun launchQr() {
        val options = ScanOptions()
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        options.setPrompt("Haydovchi QR kodini ramkaga tuting")
        options.setBeepEnabled(false)
        options.setOrientationLocked(true)
        options.setBarcodeImageEnabled(false)
        options.addExtra("ALSO_INVERTED", true)
        qrLauncher.launch(options)
    }

    private fun deliverQr(text: String) {
        val js = "(function(t){try{if(window.nexusQrResult)window.nexusQrResult(t);}catch(e){}})(${JSONObject.quote(text)})"
        web.post { web.evaluateJavascript(js, null) }
        web.postDelayed({ web.evaluateJavascript(js, null) }, 350)
    }

    private fun navigateToPoint(json: String) {
        val lat: Double
        val lng: Double
        val name: String
        try {
            val o = JSONObject(json)
            lat = o.optDouble("lat", 0.0)
            lng = o.optDouble("lng", 0.0)
            name = o.optString("name", "")
        } catch (_: Exception) {
            return
        }
        if (lat !in 37.0..46.0 || lng !in 55.0..76.0) return
        val turnByTurn = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("google.navigation:q=$lat,$lng&mode=d"),
        ).setPackage("com.google.android.apps.maps")
        try {
            startActivity(turnByTurn)
            return
        } catch (_: ActivityNotFoundException) {
        }
        val yandex = Uri.parse("yandexnavi://build_route_on_map?lat_to=$lat&lon_to=$lng")
        try {
            startActivity(Intent(Intent.ACTION_VIEW, yandex).setPackage("ru.yandex.yandexnavi"))
            return
        } catch (_: ActivityNotFoundException) {
        }
        val label = Uri.encode(name.ifBlank { "Do‘kon" })
        val geo = Uri.parse("geo:$lat,$lng?q=$lat,$lng($label)")
        try {
            startActivity(Intent(Intent.ACTION_VIEW, geo))
            return
        } catch (_: ActivityNotFoundException) {
        }
        openExternal(Uri.parse("https://www.google.com/maps/dir/?api=1&destination=$lat,$lng&travelmode=driving&dir_action=navigate"))
    }

    private fun openOrderedRoute(json: String) {
        val pts = mutableListOf<Pair<Double, Double>>()
        try {
            val arr = JSONArray(json)
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val lat = o.optDouble("lat", 0.0)
                val lng = o.optDouble("lng", 0.0)
                if (lat in 37.0..46.0 && lng in 55.0..76.0) pts.add(lat to lng)
            }
        } catch (_: Exception) {
            return
        }
        if (pts.isEmpty()) return
        val limited = pts.take(12)
        val origin = limited.first()
        val dest = limited.last()
        val via = limited.drop(1).dropLast(1)
        val mapsApi = Uri.parse(
            buildString {
                append("https://www.google.com/maps/dir/?api=1")
                append("&origin=${origin.first},${origin.second}")
                append("&destination=${dest.first},${dest.second}")
                if (via.isNotEmpty()) {
                    append("&waypoints=")
                    append(via.joinToString("%7C") { "${it.first},${it.second}" })
                }
                append("&travelmode=driving&dir_action=navigate")
            },
        )
        val path = Uri.parse(
            "https://www.google.com/maps/dir/" + limited.joinToString("/") { "${it.first},${it.second}" },
        )
        val gmaps = Intent(Intent.ACTION_VIEW, mapsApi).setPackage("com.google.android.apps.maps")
        try {
            startActivity(gmaps)
            return
        } catch (_: ActivityNotFoundException) {
        }
        val yandex = Uri.Builder()
            .scheme("yandexnavi")
            .authority("build_route_on_map")
            .appendQueryParameter("lat_from", origin.first.toString())
            .appendQueryParameter("lon_from", origin.second.toString())
            .appendQueryParameter("lat_to", dest.first.toString())
            .appendQueryParameter("lon_to", dest.second.toString())
        via.forEachIndexed { i, p ->
            yandex.appendQueryParameter("lat_via_$i", p.first.toString())
            yandex.appendQueryParameter("lon_via_$i", p.second.toString())
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW, yandex.build()).setPackage("ru.yandex.yandexnavi"))
            return
        } catch (_: ActivityNotFoundException) {
        }
        openExternal(path)
    }

    private fun isMapsUri(uri: Uri): Boolean {
        val host = uri.host?.lowercase().orEmpty()
        val scheme = uri.scheme?.lowercase().orEmpty()
        val path = uri.path?.lowercase().orEmpty()
        return scheme == "geo" ||
            scheme == "google.navigation" ||
            scheme == "yandexnavi" ||
            host.contains("google.com") && path.contains("/maps") ||
            host.contains("maps.google") ||
            host.contains("maps.app.goo") ||
            host.contains("yandex.") && (path.contains("maps") || host.contains("maps"))
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
        }
    }

    private fun errorHtml(): String {
        val urls = serverUrls().joinToString("<br>") { it.removePrefix("http://").removePrefix("https://").removeSuffix("/driver/") }
        val manual = prefs().getString("manual_url", "") ?: ""
        val manualShort = manual.removePrefix("http://").removePrefix("https://").removeSuffix("/driver/")
        return """
            <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
            <body style="background:#0c101c;color:#e8edf7;font-family:sans-serif;padding:24px;margin:0">
            <h2 style="margin-top:8px">Server topilmadi</h2>
            <p>Telefonda <b>internet</b> (mobil internet yoki Wi‑Fi) yoqilganini tekshiring.</p>
            <p style="color:#8b93a7;font-size:13px">Tekshirildi:<br>$urls</p>
            <p style="color:#8b93a7">5 soniyada qayta uriniladi…</p>
            <p><button onclick="NexusNative.retry()" style="width:100%;padding:14px 18px;border:0;border-radius:12px;background:#1d4ed8;color:#fff;font-size:16px">Qayta urinish</button></p>
            <details style="margin-top:18px;color:#8b93a7"><summary>Server manzilini qo‘lda kiritish</summary>
            <p style="font-size:13px">Odatda kerak emas. Server manzili (masalan nexuslogistic.up.railway.app) yoki sinov uchun kompyuter IPv4 manzili (masalan 10.64.46.62). Bo‘sh qoldirib saqlasangiz — standart server.</p>
            <input id="srv" value="$manualShort" placeholder="nexuslogistic.up.railway.app" inputmode="url" autocapitalize="none" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #334;background:#141a2a;color:#e8edf7;font-size:16px">
            <button onclick="NexusNative.setServer(document.getElementById('srv').value)" style="width:100%;margin-top:8px;padding:12px;border:0;border-radius:10px;background:#0f766e;color:#fff;font-size:15px">Saqlash va ulanish</button>
            </details>
            </body></html>
        """.trimIndent()
    }

    override fun onDestroy() {
        retry.removeCallbacksAndMessages(null)
        probes.shutdownNow()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (this::web.isInitialized && web.canGoBack()) web.goBack() else super.onBackPressed()
    }
}
