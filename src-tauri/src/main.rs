// Prevents an additional console window on Windows in release. DO NOT REMOVE.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // First statement, before anything else in this process does work: it is the `T0` that
    // `report_paint` subtracts from the page's first contentful paint.
    // see docs/research/perceived-performance.md §5.1 ("you cannot recover exec time after the
    // fact") and §5.3.
    brigadier_lib::mark_process_start();
    brigadier_lib::run()
}
