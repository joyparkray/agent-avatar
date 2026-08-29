fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new().file("native/AudioCapture.m").flag("-fobjc-arc").flag("-fblocks").compile("echo_audio_capture");
        for framework in ["Foundation", "CoreAudio", "AudioToolbox", "Accelerate", "QuartzCore"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    println!("cargo:rerun-if-changed=native/AudioCapture.m");
    tauri_build::build()
}
