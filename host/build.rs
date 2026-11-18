// Le pont Swift de ScreenCaptureKit a besoin du runtime Swift du système.
fn main() {
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
