# Squire's patch to rustls-platform-verifier 0.7.1

This is the crates.io release of `rustls-platform-verifier` 0.7.1 with one
change, applied through `[patch.crates-io]` in `server/Cargo.toml`.

Upstream, Android verifies certificates by calling a Kotlin class that only
exists inside an Android app (`org.rustls.platformverifier.CertificateVerifier`),
after the app hands the crate its JVM. Squire on Android is a command-line
program in Termux, with no JVM, so upstream panics on the first HTTPS
handshake ("Expect rustls-platform-verifier to be initialized").

The patch builds Android like other Unix systems instead: WebPKI over the
roots `rustls-native-certs` loads. On Android that finds Termux's bundle at
`/data/data/com.termux/files/usr/etc/tls/cert.pem` (via `openssl-probe`), and
`SSL_CERT_FILE` / `SSL_CERT_DIR` override it as usual.

Changed:

- `src/verification/mod.rs` and `src/verification/others.rs`: the
  `not(target_os = "android")` exclusions are gone; the Android verifier and
  its `ALLOWED_EKUS` are removed.
- `src/verification/android.rs`: deleted.
- `Cargo.toml`: `rustls-native-certs` and `webpki` are no longer excluded on
  Android.

Nothing changes on other targets. `src/android.rs` (the JVM initialization API)
is left in place so the crate's public API is unchanged; `src/lib.rs` allows
its now-unused helpers to be dead code on Android.

To update: copy the new release from `~/.cargo/registry/src/*/`, reapply the
changes above, and bump the version in this file. Drop the patch once upstream
has a non-JVM Android fallback.
