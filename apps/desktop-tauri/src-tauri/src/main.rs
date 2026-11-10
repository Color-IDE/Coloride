use coloride_desktop_lib::{collect_system_diagnostics, DesktopBinaryEditorBridge};

#[tokio::main]
async fn main() {
    let report = collect_system_diagnostics();
    let mut bridge = DesktopBinaryEditorBridge::new_in_memory();
    let boot_snap = bridge
        .lazy_boot_restore(None)
        .expect("Lazy Boot interactive session restoration");
    let bg_status = bridge
        .spawn_background_services()
        .await
        .expect("background services initialization");

    println!(
        "Coloride Desktop Host initialized (host={}, sandbox={:?}, lazy_boot={}us, active_doc={}, bg_ready={})",
        report.host.version,
        report.sandbox.native_os_kind,
        boot_snap.boot_to_interactive_us,
        boot_snap.restored_editor_snapshot.document_id,
        bg_status.all_ready()
    );
}
