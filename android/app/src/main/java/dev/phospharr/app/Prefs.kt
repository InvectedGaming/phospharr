package dev.phospharr.app

import android.content.Context

/** The single stored setting: which Phospharr server this device points at. */
object Prefs {
    private const val FILE = "phospharr"
    private const val KEY_URL = "server_url"

    fun serverUrl(ctx: Context): String? =
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY_URL, null)

    fun setServerUrl(ctx: Context, url: String) {
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY_URL, url).apply()
    }

    fun clear(ctx: Context) {
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().remove(KEY_URL).apply()
    }
}
