from pathlib import Path


def run():
    root = Path(__file__).resolve().parent.parent
    launcher = (root / "Start LectureAI Laptop AI.bat").read_text(encoding="utf-8")
    one_click = (root / "Start LectureAI.bat").read_text(encoding="utf-8")
    status_launcher = (root / "LectureAI Status.bat").read_text(encoding="utf-8")
    runtime = (root / "windows" / "lectureai-runtime.ps1").read_text(encoding="utf-8")
    selector = (root / "local-ai" / "select_lan_ipv4.ps1").read_text(encoding="utf-8")
    server = (root / "local-ai" / "server.py").read_text(encoding="utf-8")
    assert "Get-NetAdapter" in selector and "Get-NetIPConfiguration" in selector and "Get-NetIPInterface" in selector
    assert "vEthernet" in selector and "VPN" in selector and "169.254" in selector
    assert "lectureai-runtime.ps1" in launcher
    assert "-MetroMode lan" in one_click and "-Action Launch" in one_click
    assert "-Action Status" in status_launcher
    assert "Get-LanCandidates" in runtime and "Choose the network used by your iPhone/iPad" in runtime
    assert "No server was started" in runtime
    assert "Start-Process" in runtime and "-WindowStyle Hidden" in runtime
    assert "http://127.0.0.1:8081/status" in runtime and "packager-status:running" in runtime
    assert "Wait-ForMetroHealth" in runtime and "Wait-ForHelperHealth" in runtime
    assert "Start-DetachedCoordinator" in runtime and "StartCoordinator" in runtime
    assert "highest-ranked adapter" in runtime
    assert "startup: IN PROGRESS" in runtime and "Stop-OwnedTree 'launcher'" in runtime
    assert "Get-InstalledModel 'medium'" in runtime
    assert "valid_lan_bind_host" in server
    assert "Empty, malformed, loopback, link-local, and public addresses are rejected" in server
    assert 'host=address' in server and 'host=address or "0.0.0.0"' not in server
    print("[PASS] launcher emits/captures only validated private LAN candidates")


if __name__ == "__main__":
    run()
