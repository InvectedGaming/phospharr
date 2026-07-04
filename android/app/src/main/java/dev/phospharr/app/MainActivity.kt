package dev.phospharr.app

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * The whole app: a WebView pointed at the user's Phospharr server. Android
 * WebView has full Media Source Extensions, so the site's mpegts.js player,
 * guide, DVR, VOD and mosaic all work exactly as in Chrome — this is a thin,
 * installable shell, not a reimplementation.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var fullscreenContainer: FrameLayout
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val url = Prefs.serverUrl(this)
        if (url == null) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        fullscreenContainer = findViewById(R.id.fullscreenContainer)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false // let TV/guide previews autoplay
            loadWithOverviewMode = true
            useWideViewPort = true
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        }
        web.setBackgroundColor(Color.parseColor("#0C0D0E"))

        // Keep navigation inside the WebView; a hard load error means the server
        // is unreachable or the address is wrong — send the user back to setup.
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean = false
            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) {
                    Toast.makeText(this@MainActivity, "Can't reach the server — check the address.", Toast.LENGTH_LONG).show()
                    changeServer()
                }
            }
        }

        // Fullscreen video: the site's player calls requestFullscreen(); host the
        // returned view in an overlay so video fills the screen (and the TV).
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) { callback.onCustomViewHidden(); return }
                customView = view
                customCallback = callback
                fullscreenContainer.addView(view, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                fullscreenContainer.visibility = View.VISIBLE
                web.visibility = View.GONE
            }
            override fun onHideCustomView() {
                customView?.let { fullscreenContainer.removeView(it) }
                fullscreenContainer.visibility = View.GONE
                web.visibility = View.VISIBLE
                customView = null
                customCallback?.onCustomViewHidden()
                customCallback = null
            }
        }

        web.loadUrl(url)
    }

    /** Back exits video fullscreen, then walks WebView history, then exits. */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            customView != null -> web.webChromeClient?.onHideCustomView()
            web.canGoBack() -> web.goBack()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    /** Long-press the menu/back key to re-point the app at a different server. */
    override fun onKeyLongPress(keyCode: Int, event: android.view.KeyEvent?): Boolean {
        if (keyCode == android.view.KeyEvent.KEYCODE_MENU || keyCode == android.view.KeyEvent.KEYCODE_BACK) {
            changeServer(); return true
        }
        return super.onKeyLongPress(keyCode, event)
    }

    private fun changeServer() {
        startActivity(Intent(this, SetupActivity::class.java))
        finish()
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }
}
