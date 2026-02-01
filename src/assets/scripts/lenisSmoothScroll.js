import "@styles/lenis.css";

import Lenis from "lenis";

// Script to handle Lenis library settings for smooth scrolling
// https://github.com/darkroomengineering/lenis
const lenis = new Lenis({
    autoRaf: true,
    duration: 1.2,        // Faster scroll duration (default is 1.2, lower = faster)
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), // Smooth easing
    smooth: true,
    smoothTouch: false,   // Disable smooth scroll on touch devices for better performance
    syncTouch: false,     // Don't sync touch with smooth scroll
});