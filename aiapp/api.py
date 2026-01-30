# main.py  (FastAPI backend) — COMPLETE
# ------------------------------------------------------------
# Features:
# ✅ /metadata, /folders, /upload, /delete file, /search (table)
# ✅ /chat/search (chat mode with full conversation context)
# ✅ On upload: create <stem>_<id>_normalised.json (empty JSON)
# ✅ On delete: delete original + normalized
# ✅ Atomic metadata save + lock
# ✅ TEST: /search supports optional delay knobs
#
# Run:
#   pip install fastapi uvicorn python-multipart pydantic
#   uvicorn main:app --reload
# ------------------------------------------------------------

from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional, Literal
import json, shutil, threading, time
from pathlib import Path
from uuid import uuid4


APP_ROOT = Path(__file__).parent.resolve()
STORAGE_DIR = APP_ROOT / "storage"
META_PATH = STORAGE_DIR / "metadata.json"

STORAGE_DIR.mkdir(parents=True, exist_ok=True)

# ---- server-side limits (match frontend) ----
MAX_FILES_PER_UPLOAD = 50
MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024  # 50MB

# ---- lock to prevent metadata.json corruption on concurrent requests ----
META_LOCK = threading.Lock()


def _default_metadata() -> Dict[str, Any]:
    return {"folders": [{"id": "root", "name": "Root", "files": []}]}


def _save_metadata(data: Dict[str, Any]) -> None:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = META_PATH.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    tmp.replace(META_PATH)  # atomic write


def _load_metadata() -> Dict[str, Any]:
    if not META_PATH.exists():
        data = _default_metadata()
        _save_metadata(data)
        return data

    try:
        with META_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)

        if not isinstance(data, dict) or "folders" not in data or not isinstance(data["folders"], list):
            data = _default_metadata()
            _save_metadata(data)

        if not any(f.get("id") == "root" for f in data["folders"]):
            data["folders"].insert(0, {"id": "root", "name": "Root", "files": []})
            _save_metadata(data)

        # ensure storage dirs exist
        for fd in data["folders"]:
            (STORAGE_DIR / fd["id"]).mkdir(parents=True, exist_ok=True)

        return data
    except Exception:
        data = _default_metadata()
        _save_metadata(data)
        return data


def _get_folder(data: Dict[str, Any], folder_id: str) -> Dict[str, Any]:
    for f in data["folders"]:
        if f.get("id") == folder_id:
            return f
    raise HTTPException(status_code=404, detail=f"Folder not found: {folder_id}")


def _sanitize_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Folder name is required")
    if len(name) > 60:
        raise HTTPException(status_code=400, detail="Folder name too long (max 60)")
    bad = ['\\', '/', ':', '*', '?', '"', '<', '>', '|']
    if any(ch in name for ch in bad):
        raise HTTPException(status_code=400, detail='Folder name cannot include \\ / : * ? " < > |')
    return name


def _safe_rel_path(p: str) -> str:
    p = (p or "").replace("\\", "/").strip()
    if not p:
        raise HTTPException(status_code=400, detail="server_name is required")
    if ".." in p.split("/"):
        raise HTTPException(status_code=400, detail="Invalid server_name path")
    return p


def _safe_full_path(server_name: str) -> Path:
    """
    Convert server_name like 'fld_xxx/file.pdf' into a safe absolute path inside STORAGE_DIR.
    """
    rel = _safe_rel_path(server_name)
    full = (STORAGE_DIR / rel).resolve()
    base = STORAGE_DIR.resolve()
    if not str(full).startswith(str(base)):
        raise HTTPException(status_code=400, detail="Invalid server_name path")
    return full


def _find_file_entry(folder: Dict[str, Any], server_name: str) -> Optional[Dict[str, Any]]:
    for fe in folder.get("files", []):
        if fe.get("server_name") == server_name:
            return fe
    return None


def _delete_path_quiet(server_name: Optional[str]) -> None:
    if not server_name:
        return
    try:
        full = _safe_full_path(server_name)
        if full.exists():
            full.unlink()
    except Exception:
        pass


def _create_empty_normalised_json(full_path: Path) -> None:
    """
    Creates an empty "normalised" JSON file.
    Structure: {"items": []}
    """
    full_path.parent.mkdir(parents=True, exist_ok=True)
    if not full_path.exists():
        with full_path.open("w", encoding="utf-8") as f:
            json.dump({"items": []}, f)


def _validate_files_for_folder(folder: Dict[str, Any], files: List[str]) -> None:
    allowed = set(f.get("server_name") for f in folder.get("files", []))
    missing = []
    not_in_folder = []

    for f in files:
        f = _safe_rel_path(f)
        if f not in allowed:
            not_in_folder.append(f)
            continue
        if not _safe_full_path(f).exists():
            missing.append(f)

    if not_in_folder:
        raise HTTPException(status_code=400, detail=f"Some files not in selected folder: {not_in_folder[:5]}")
    if missing:
        raise HTTPException(status_code=400, detail=f"Some files missing on server: {missing[:5]}")


app = FastAPI()

# ✅ CORS for React dev servers (Vite/CRA)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -------------------- USER PROFILE --------------------
@app.get("/me")
def me():
    return {
        "id": "u_001",
        "name": "Rajendra Jain",
        "email": "rajendra@example.com",
        "role": "User",
    }


# -------------------- METADATA --------------------
@app.get("/metadata")
def metadata():
    with META_LOCK:
        return _load_metadata()


# -------------------- FOLDERS --------------------
@app.post("/folders")
def create_folder(name: str = Form(...)):
    with META_LOCK:
        data = _load_metadata()
        name = _sanitize_name(name)

        if any(str(f.get("name", "")).lower() == name.lower() for f in data["folders"]):
            raise HTTPException(status_code=400, detail="Folder name already exists")

        folder_id = f"fld_{uuid4().hex[:10]}"
        data["folders"].append({"id": folder_id, "name": name, "files": []})
        (STORAGE_DIR / folder_id).mkdir(parents=True, exist_ok=True)

        _save_metadata(data)
        return {"folders": data["folders"]}


@app.delete("/folders/{folder_id}")
def delete_folder(folder_id: str):
    if folder_id == "root":
        raise HTTPException(status_code=400, detail="Root folder cannot be deleted")

    with META_LOCK:
        data = _load_metadata()
        _get_folder(data, folder_id)

        folder_path = STORAGE_DIR / folder_id
        if folder_path.exists():
            shutil.rmtree(folder_path, ignore_errors=True)

        data["folders"] = [f for f in data["folders"] if f.get("id") != folder_id]
        _save_metadata(data)
        return {"folders": data["folders"]}


# -------------------- UPLOAD --------------------
@app.post("/upload")
async def upload(folder_id: str = Query(..., min_length=1), files: List[UploadFile] = File(...)):
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")
    if len(files) > MAX_FILES_PER_UPLOAD:
        raise HTTPException(status_code=400, detail=f"Too many files. Max {MAX_FILES_PER_UPLOAD} per upload.")

    with META_LOCK:
        data = _load_metadata()
        folder = _get_folder(data, folder_id)

        folder_path = STORAGE_DIR / folder_id
        folder_path.mkdir(parents=True, exist_ok=True)

        existing_by_name = {fe.get("original_name"): fe for fe in folder.get("files", [])}

        for up in files:
            if not up.filename:
                continue

            orig = up.filename
            file_id = uuid4().hex[:8]

            safe_orig = orig.replace("\\", "_").replace("/", "_")
            stem = Path(safe_orig).stem
            suffix = Path(safe_orig).suffix

            unique_name = f"{stem}_{file_id}{suffix}"
            full_path = folder_path / unique_name

            norm_name = f"{stem}_{file_id}_normalised.json"
            norm_full_path = folder_path / norm_name

            size = 0
            with full_path.open("wb") as out:
                while True:
                    chunk = await up.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_FILE_SIZE_BYTES:
                        try:
                            out.close()
                        finally:
                            if full_path.exists():
                                full_path.unlink(missing_ok=True)
                        raise HTTPException(
                            status_code=400,
                            detail=f"File too large: {orig} (max {MAX_FILE_SIZE_BYTES} bytes)",
                        )
                    out.write(chunk)

            _create_empty_normalised_json(norm_full_path)

            rel_server_name = f"{folder_id}/{unique_name}"
            rel_norm_server_name = f"{folder_id}/{norm_name}"

            entry = {
                "original_name": orig,
                "server_name": rel_server_name,
                "size": size,
                "normalized_server_name": rel_norm_server_name,
            }

            if orig in existing_by_name:
                old = existing_by_name[orig]
                _delete_path_quiet(old.get("server_name"))
                _delete_path_quiet(old.get("normalized_server_name"))
                folder["files"] = [x for x in folder["files"] if x.get("server_name") != old.get("server_name")]

            folder["files"].append(entry)
            existing_by_name[orig] = entry

        _save_metadata(data)
        return {"ok": True, "metadata": data}


# -------------------- DELETE FILE --------------------
@app.delete("/folders/{folder_id}/files")
def delete_file(folder_id: str, server_name: str = Query(...)):
    with META_LOCK:
        data = _load_metadata()
        folder = _get_folder(data, folder_id)

        server_name = _safe_rel_path(server_name)
        entry = _find_file_entry(folder, server_name)
        if not entry:
            raise HTTPException(status_code=404, detail="File not found in metadata")

        _delete_path_quiet(entry.get("server_name"))
        _delete_path_quiet(entry.get("normalized_server_name"))

        folder["files"] = [f for f in folder["files"] if f.get("server_name") != server_name]
        _save_metadata(data)
        return {"folders": data["folders"]}


# -------------------- SEARCH (TABLE) --------------------
class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=5000)
    folder_id: str = Field(..., min_length=1, max_length=200)
    files: List[str] = Field(default_factory=list, min_length=1)

    # TEST knobs
    delay_ms: int = Field(default=0, ge=0, le=300000)
    per_file_delay_ms: int = Field(default=0, ge=0, le=60000)


def _simulate_results(folder_id: str, files: List[str], q: str) -> List[Dict[str, Any]]:
    results = []
    for idx, f in enumerate(files, start=1):
        results.append(
            {
                "resultId": idx,
                "folderId": folder_id,
                "file": f,
                "query": q,
                "score": round(0.85 + (idx % 10) * 0.01, 2),
                "page": 1 + (idx % 5),
                "line": 10 + idx,
                "snippet": f"Found '{q}' in {f} (sample snippet)",
                "source": "FastAPI",
            }
        )
    return results


@app.post("/search")
def search(req: SearchRequest) -> Dict[str, Any]:
    with META_LOCK:
        data = _load_metadata()
        folder = _get_folder(data, req.folder_id)

    q = req.query.strip()
    if not q:
        raise HTTPException(status_code=400, detail="query is required")

    _validate_files_for_folder(folder, req.files)

    # simulate slowness when > 5 files
    if len(req.files) > 5:
        fixed = (req.delay_ms or 0) / 1000.0
        per_file = (req.per_file_delay_ms or 0) / 1000.0
        if fixed == 0 and per_file == 0:
            fixed = 2.0
            per_file = 0.5
        time.sleep(fixed + per_file * len(req.files))

    return {"LLMRESPONSE": _simulate_results(req.folder_id, req.files, q)}


# -------------------- CHAT SEARCH (WITH CONTEXT) --------------------
class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1, max_length=20000)


class ChatSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=5000)
    folder_id: str = Field(..., min_length=1, max_length=200)
    files: List[str] = Field(default_factory=list, min_length=1)
    messages: List[ChatMessage] = Field(default_factory=list)


@app.post("/chat/search")
def chat_search(req: ChatSearchRequest) -> Dict[str, Any]:
    with META_LOCK:
        data = _load_metadata()
        folder = _get_folder(data, req.folder_id)

    q = req.query.strip()
    if not q:
        raise HTTPException(status_code=400, detail="query is required")

    _validate_files_for_folder(folder, req.files)

    # You can plug your real retrieval + LLM here.
    # For now: return same grid results + an assistant message that "uses context"
    results = _simulate_results(req.folder_id, req.files, q)

    # very simple "context use" demo
    last_user_msgs = [m.content for m in req.messages if m.role == "user"][-3:]
    context_line = " | ".join(last_user_msgs) if last_user_msgs else "(no prior chat)"

    assistant_text = (
        f"Got it. You asked: '{q}'.\n"
        f"Recent context: {context_line}\n\n"
        f"I found {len(results)} matches in your selected folder files. "
        f"Switch to the Table tab to view the full grid results."
    )

    return {
        "assistant_text": assistant_text,
        "LLMRESPONSE": results,
    }


# -------------------- IQA (as you had) --------------------
class IQAProcessRequest(BaseModel):
    folder_id: str = Field(..., min_length=1, max_length=200)
    files: List[str] = Field(default_factory=list, min_length=1)


@app.post("/iqa/process")
def iqa_process(req: IQAProcessRequest) -> Dict[str, Any]:
    with META_LOCK:
        data = _load_metadata()
        folder = _get_folder(data, req.folder_id)

    _validate_files_for_folder(folder, req.files)

    rows = []
    for idx, f in enumerate(req.files, start=1):
        rows.append(
            {
                "rowId": idx,
                "folderId": req.folder_id,
                "file": f,
                "status": "Processed",
                "confidence": round(0.78 + (idx % 10) * 0.02, 2),
                "output": f"IQA output sample for {Path(f).name}",
                "source": "FastAPI",
            }
        )

    return {"IQA_RESPONSE": rows}
