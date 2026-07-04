package dev.phospharr.app

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/** First-run (and "change server") screen: capture the self-hosted server URL. */
class SetupActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        val field = findViewById<EditText>(R.id.serverUrl)
        field.setText(Prefs.serverUrl(this) ?: "http://")

        val go = {
            val raw = field.text.toString().trim().trimEnd('/')
            if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
                Toast.makeText(this, R.string.invalid_url, Toast.LENGTH_LONG).show()
            } else {
                Prefs.setServerUrl(this, raw)
                startActivity(Intent(this, MainActivity::class.java))
                finish()
            }
        }
        findViewById<Button>(R.id.connectBtn).setOnClickListener { go() }
        field.setOnEditorActionListener { _, _, _ -> go(); true }
    }
}
