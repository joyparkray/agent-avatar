const core = document.createElement("script");
core.src = "/vendor/live2d-core/live2dcubismcore.min.js";
core.onload = () => void import("./main");
core.onerror = () => console.error("Cubism Core failed to load");
document.head.append(core);
