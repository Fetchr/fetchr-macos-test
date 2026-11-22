fn main() {
    println!("cargo:rerun-if-changed=setup.rc");
    println!("cargo:rerun-if-changed=setup.manifest");
    println!("cargo:rerun-if-changed=ui/index.html");
    if std::env::var("CARGO_CFG_WINDOWS").is_ok() {
        embed_resource::compile("setup.rc", embed_resource::NONE)
            .manifest_optional()
            .expect("setup.rc must compile: icon and manifest are part of the installer");
    }
}
