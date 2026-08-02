import os
import subprocess
import sys
import threading

IS_WINDOWS = sys.platform == "win32"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(REPO_ROOT, "frontend")

processes: list[subprocess.Popen] = []


def prefix_output(proc: subprocess.Popen, prefix: str):
    try:
        for line in iter(proc.stdout.readline, ""):
            line = line.rstrip("\r\n")
            if not line:
                break
            sys.stdout.write(f"[{prefix}] {line}\n")
            sys.stdout.flush()
    except ValueError:
        pass
    try:
        for line in iter(proc.stderr.readline, ""):
            line = line.rstrip("\r\n")
            if not line:
                break
            sys.stderr.write(f"[{prefix}] {line}\n")
            sys.stderr.flush()
    except ValueError:
        pass


def cleanup():
    for proc in processes:
        if proc.poll() is None:
            proc.terminate()
    for proc in processes:
        try:
            proc.wait(timeout=5)
        except (subprocess.TimeoutExpired, OSError):
            try:
                proc.kill()
            except OSError:
                pass


backend = subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "backend.main:app", "--reload", "--port", "8000"],
    cwd=REPO_ROOT,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
)
processes.append(backend)

npm_cmd = "npm.cmd" if IS_WINDOWS else "npm"

print("Installing frontend dependencies...")
node_modules_dir = os.path.join(FRONTEND_DIR, "node_modules")
if os.path.isdir(node_modules_dir):
    import shutil
    shutil.rmtree(node_modules_dir, ignore_errors=True)
subprocess.run(
    [npm_cmd, "install", "--no-audit", "--no-fund"],
    cwd=FRONTEND_DIR,
    capture_output=True,
    text=True,
)
print("Starting frontend dev server...\n")

frontend = subprocess.Popen(
    [npm_cmd, "run", "dev"],
    cwd=FRONTEND_DIR,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
)
processes.append(frontend)

t1 = threading.Thread(target=prefix_output, args=(backend, "backend"), daemon=True)
t2 = threading.Thread(target=prefix_output, args=(frontend, "frontend"), daemon=True)
t1.start()
t2.start()

print("Running companion demo...")
print("  Backend:  http://localhost:8000")
print("  Frontend: http://localhost:5173")
print("  Health:   http://localhost:8000/health")
print("Press Ctrl+C to stop both.\n")

try:
    t1.join()
    t2.join()
except KeyboardInterrupt:
    cleanup()
