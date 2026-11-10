use coloride_desktop_lib::collect_system_diagnostics;

fn main() {
    let report = collect_system_diagnostics();
    println!(
        "Coloride Desktop Host initialized (host={}, sandbox={:?})",
        report.host.version, report.sandbox.native_os_kind
    );
}
