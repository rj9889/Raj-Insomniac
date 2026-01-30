// src/App.jsx  (COMPLETE)
// ----------------------------------------------------------------------------------------------------
// ✅ Chat + Table tabs (manual switch only; NO auto-switch)
// ✅ Chat history never disappears (right side user, left side assistant)
// ✅ Separate Chat Query vs Table Query (fix cross-impact bugs)
// ✅ Separate searchingChat vs searchingTable (fix shared spinner bugs)
// ✅ Table search uses POST /search (no chat side effects)
// ✅ Chat search uses POST /chat/search and sends full conversation context
// ✅ Per-folder sessions + per-folder upload + cancel search + race-proof requestId
//
// Install:
//   npm i xlsx file-saver
//
// Run (Vite):
//   npm install
//   npm run dev
// ----------------------------------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";

/* ===================== CONFIG ===================== */
const API_BASE = "http://127.0.0.1:8000";

const ENDPOINTS = {
  me: `${API_BASE}/me`,
  metadata: `${API_BASE}/metadata`,
  createFolder: `${API_BASE}/folders`,
  deleteFolder: (folderId) => `${API_BASE}/folders/${folderId}`,
  upload: `${API_BASE}/upload`,
  deleteFile: (folderId, serverName) =>
    `${API_BASE}/folders/${folderId}/files?server_name=${encodeURIComponent(serverName)}`,

  // ✅ table search
  search: `${API_BASE}/search`,

  // ✅ chat search (new)
  chatSearch: `${API_BASE}/chat/search`,
};

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

const RULES = {
  folderNameMax: 60,
  queryMax: 5000,
  maxFilesPerUpload: 50,
  maxFileSizeBytes: 50 * 1024 * 1024, // 50MB
};

/* ===================== HELPERS ===================== */
function safeReadText(res) {
  return res.text().catch(() => "");
}
function initials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "U";
  const first = parts[0][0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}
function prettyBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}
function normalizeErr(e) {
  const msg = String(e?.message || e || "Unknown error");
  if (msg.includes("Failed to fetch")) {
    return (
      "Cannot reach API (Failed to fetch). " +
      "Check: FastAPI running, correct URL, CORS enabled, and use http://127.0.0.1:8000 (not 0.0.0.0)."
    );
  }
  return msg;
}
function validateFolderName(name) {
  const s = String(name || "").trim();
  if (!s) return { ok: false, msg: "Folder name is required." };
  if (s.length > RULES.folderNameMax) return { ok: false, msg: `Folder name max ${RULES.folderNameMax} chars.` };
  if (/[\\/:*?"<>|]/.test(s)) return { ok: false, msg: 'Folder name cannot include \\ / : * ? " < > |' };
  return { ok: true, msg: "" };
}
function validateQuery(q) {
  const s = String(q || "").trim();
  if (!s) return { ok: false, msg: "Search text is required." };
  if (s.length > RULES.queryMax) return { ok: false, msg: `Search text too long (max ${RULES.queryMax}).` };
  return { ok: true, msg: "" };
}
function validateFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return { ok: false, msg: "No files selected." };
  if (files.length > RULES.maxFilesPerUpload)
    return { ok: false, msg: `Too many files. Max ${RULES.maxFilesPerUpload} per upload.` };
  for (const f of files) {
    if ((f?.size || 0) > RULES.maxFileSizeBytes) {
      return {
        ok: false,
        msg: `File too large: ${f.name} (${prettyBytes(f.size)}). Max ${prettyBytes(RULES.maxFileSizeBytes)}.`,
      };
    }
  }
  return { ok: true, msg: "" };
}
function cellText(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/* ===================== CHAT HELPERS ===================== */
function nowHHMM() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function rowsToChatText(rows) {
  if (!Array.isArray(rows) || !rows.length) return "No results found.";

  const looksSimple = rows.every(
    (r) =>
      r &&
      typeof r === "object" &&
      !Array.isArray(r) &&
      Object.keys(r).every((k) => ["value", "_index"].includes(k))
  );
  if (looksSimple) {
    return rows
      .map((r) => `• ${String(r.value ?? "").trim()}`)
      .filter(Boolean)
      .join("\n");
  }

  const hasAnswer = rows.some((r) => r && typeof r === "object" && "answer" in r);
  if (hasAnswer) {
    return rows
      .map((r) => {
        const ans = r?.answer ? String(r.answer) : "";
        const files =
          Array.isArray(r?.matched_files) && r.matched_files.length ? `\nFiles: ${r.matched_files.join(", ")}` : "";
        return `${ans}${files}`.trim();
      })
      .join("\n\n");
  }

  return rows
    .map((r, idx) => {
      const keys = Object.keys(r || {}).filter((k) => k !== "_index");
      if (!keys.length) return `${idx + 1}. (empty row)`;
      const lines = keys.map((k) => `${k}: ${cellText(r?.[k])}`);
      return `${idx + 1}.\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/* ===================== PER-FOLDER SESSION ===================== */
function defaultSession() {
  return {
    error: "",
    viewMode: "chat",

    // ✅ CHAT
    chatQuery: "",
    searchingChat: false,
    chat: [],

    // ✅ TABLE
    tableQuery: "",
    searchingTable: false,
    rows: [],
    sortConfig: { key: null, direction: "asc" },
    pageSize: 10,
    currentPage: 1,
  };
}

export default function App() {
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const [user, setUser] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);

  const [folders, setFolders] = useState([{ id: "root", name: "Root", files: [] }]);
  const [selectedFolderId, setSelectedFolderId] = useState("root");
  const [newFolderName, setNewFolderName] = useState("");

  const [folderSearch, setFolderSearch] = useState({}); // { [folderId]: session }

  // ✅ per folder + per mode (chat/table)
  const abortRef = useRef({});     // { "fld|chat": AbortController, "fld|table": AbortController }
  const reqIdRef = useRef({});     // { "fld|chat": number, "fld|table": number }

  const [busy, setBusy] = useState({
    metadata: false,
    createFolder: false,
    deleteFolder: false,
    deleteFile: false,
  });

  const [uploadBusyByFolder, setUploadBusyByFolder] = useState({}); // { [folderId]: boolean }

  const chatEndRef = useRef(null);
  const chatInputRef = useRef(null);

  function keyFor(folderId, mode) {
    return `${folderId}|${mode}`;
  }

  function isUploadBusy(folderId) {
    return !!uploadBusyByFolder[folderId];
  }
  function setUploadBusy(folderId, val) {
    setUploadBusyByFolder((prev) => ({ ...prev, [folderId]: !!val }));
  }

  const selectedFolder = useMemo(
    () => folders.find((f) => f.id === selectedFolderId) || folders[0],
    [folders, selectedFolderId]
  );

  function getSession(folderId) {
    return folderSearch[folderId] || defaultSession();
  }

  function updateSession(folderId, patch) {
    setFolderSearch((prev) => {
      const current = { ...defaultSession(), ...(prev[folderId] || {}) };
      return { ...prev, [folderId]: { ...current, ...patch } };
    });
  }

  function pushChat(folderId, role, text) {
    const msg = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      role, // "user" | "assistant"
      text: String(text ?? ""),
      ts: nowHHMM(),
    };

    setFolderSearch((prev) => {
      const current = { ...defaultSession(), ...(prev[folderId] || {}) };
      const nextChat = [...(current.chat || []), msg];
      return { ...prev, [folderId]: { ...current, chat: nextChat } };
    });
  }

  // derived
  const session = getSession(selectedFolderId);
  const viewMode = session.viewMode;

  const query = viewMode === "chat" ? session.chatQuery : session.tableQuery;
  const isSearching = viewMode === "chat" ? session.searchingChat : session.searchingTable;

  const rows = session.rows;
  const sortConfig = session.sortConfig;
  const pageSize = session.pageSize;
  const currentPage = session.currentPage;
  const error = session.error;
  const chat = session.chat || [];

  useEffect(() => {
    if (viewMode !== "chat") return;
    try {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    } catch {}
  }, [chat.length, isSearching, viewMode]);

  const columns = useMemo(() => {
    if (!rows.length) return [];
    const set = new Set();
    for (const r of rows) {
      if (r && typeof r === "object" && !Array.isArray(r)) Object.keys(r).forEach((k) => set.add(k));
    }
    return Array.from(set);
  }, [rows]);

  const sortedRows = useMemo(() => {
    if (!sortConfig.key) return rows;
    const key = sortConfig.key;
    const dir = sortConfig.direction;

    const arr = [...rows];
    arr.sort((a, b) => {
      const av = a?.[key];
      const bv = b?.[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;

      const aNum = typeof av === "number" ? av : Number(av);
      const bNum = typeof bv === "number" ? bv : Number(bv);
      const bothNumeric = !Number.isNaN(aNum) && !Number.isNaN(bNum);

      let cmp = 0;
      if (bothNumeric) cmp = aNum === bNum ? 0 : aNum > bNum ? 1 : -1;
      else cmp = String(av).localeCompare(String(bv));

      return dir === "asc" ? cmp : -cmp;
    });

    return arr;
  }, [rows, sortConfig]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const paginatedRows = sortedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const hasResults = paginatedRows.length > 0;

  const disableFolderDelete = busy.metadata || busy.createFolder || busy.deleteFolder;
  const disableDeleteFile = busy.metadata || busy.createFolder || busy.deleteFolder || busy.deleteFile;
  const disableUploadCurrentFolder = busy.metadata || busy.createFolder || busy.deleteFolder || isUploadBusy(selectedFolderId);

  function showToast(type, msg) {
    setToast({ type, msg });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }

  async function loadUser() {
    try {
      const res = await fetch(ENDPOINTS.me);
      if (!res.ok) throw new Error(`User API failed: ${res.status}`);
      const json = await res.json();
      setUser({
        name: json?.name || "User",
        email: json?.email || "",
        role: json?.role || "User",
      });
    } catch {
      setUser(null);
    }
  }

  function syncSessionsWithFolders(newFolders) {
    const ids = new Set((newFolders || []).map((f) => f.id));
    setFolderSearch((prev) => {
      const next = { ...prev };
      for (const id of ids) if (!next[id]) next[id] = defaultSession();
      for (const id of Object.keys(next)) if (!ids.has(id)) delete next[id];
      return next;
    });
  }

  async function loadMetadata() {
    setBusy((b) => ({ ...b, metadata: true }));
    try {
      const res = await fetch(ENDPOINTS.metadata);
      if (!res.ok) {
        const t = await safeReadText(res);
        throw new Error(t || `Metadata failed: ${res.status}`);
      }
      const json = await res.json();
      if (!Array.isArray(json?.folders)) throw new Error("Invalid metadata response: expected {folders:[]}");
      setFolders(json.folders);
      syncSessionsWithFolders(json.folders);

      if (!json.folders.some((f) => f.id === selectedFolderId)) setSelectedFolderId("root");
    } catch (e) {
      const msg = normalizeErr(e);
      updateSession(selectedFolderId, { error: msg });
      showToast("error", msg);
    } finally {
      setBusy((b) => ({ ...b, metadata: false }));
    }
  }

  useEffect(() => {
    loadUser();
    loadMetadata();

    const onDocClick = (e) => {
      const el = e.target;
      if (!el.closest?.("[data-profile-root]")) setProfileOpen(false);
    };
    document.addEventListener("click", onDocClick);

    return () => {
      document.removeEventListener("click", onDocClick);
      if (toastTimer.current) clearTimeout(toastTimer.current);

      // abort all searches
      for (const c of Object.values(abortRef.current || {})) {
        try {
          c?.abort?.();
        } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createFolder() {
    const v = validateFolderName(newFolderName);
    if (!v.ok) return showToast("error", v.msg);

    const name = newFolderName.trim();
    if (folders.some((f) => String(f.name || "").toLowerCase() === name.toLowerCase())) {
      return showToast("error", "Folder name already exists.");
    }

    setBusy((b) => ({ ...b, createFolder: true }));
    try {
      const form = new FormData();
      form.append("name", name);

      const res = await fetch(ENDPOINTS.createFolder, { method: "POST", body: form });
      if (!res.ok) {
        const t = await safeReadText(res);
        throw new Error(t || `Create folder failed: ${res.status}`);
      }
      const json = await res.json();
      if (!Array.isArray(json?.folders)) throw new Error("Invalid create-folder response: expected {folders:[]}");
      setFolders(json.folders);
      syncSessionsWithFolders(json.folders);

      const created = json.folders.find((f) => String(f.name || "").toLowerCase() === name.toLowerCase());
      if (created?.id) setSelectedFolderId(created.id);

      setNewFolderName("");
      showToast("success", `Folder created: ${name}`);
    } catch (e) {
      const msg = normalizeErr(e);
      updateSession(selectedFolderId, { error: msg });
      showToast("error", msg);
    } finally {
      setBusy((b) => ({ ...b, createFolder: false }));
    }
  }

  async function deleteFolder(folderId) {
    if (folderId === "root") return showToast("error", "Root folder cannot be deleted.");

    setBusy((b) => ({ ...b, deleteFolder: true }));
    try {
      const res = await fetch(ENDPOINTS.deleteFolder(folderId), { method: "DELETE" });
      if (!res.ok) {
        const t = await safeReadText(res);
        throw new Error(t || `Delete folder failed: ${res.status}`);
      }
      const json = await res.json();
      if (!Array.isArray(json?.folders)) throw new Error("Invalid delete-folder response: expected {folders:[]}");
      setFolders(json.folders);
      syncSessionsWithFolders(json.folders);

      // abort any searches for that folder (both modes)
      for (const mode of ["chat", "table"]) {
        const k = keyFor(folderId, mode);
        if (abortRef.current[k]) {
          try {
            abortRef.current[k].abort();
          } catch {}
          delete abortRef.current[k];
        }
        delete reqIdRef.current[k];
      }

      setSelectedFolderId("root");
      showToast("success", "Folder deleted.");
    } catch (e) {
      const msg = normalizeErr(e);
      updateSession(selectedFolderId, { error: msg });
      showToast("error", msg);
    } finally {
      setBusy((b) => ({ ...b, deleteFolder: false }));
    }
  }

  async function uploadFiles(e) {
    const input = e.target;
    const folderId = selectedFolderId;

    const check = validateFiles(input.files);
    if (!check.ok) {
      showToast("error", check.msg);
      input.value = "";
      return;
    }

    setUploadBusy(folderId, true);
    updateSession(folderId, { error: "" });

    try {
      const form = new FormData();
      Array.from(input.files).forEach((f) => form.append("files", f));

      const res = await fetch(`${ENDPOINTS.upload}?folder_id=${encodeURIComponent(folderId)}`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const t = await safeReadText(res);
        throw new Error(t || `Upload failed: ${res.status}`);
      }

      const json = await res.json();
      const md = json?.metadata;

      if (md?.folders && Array.isArray(md.folders)) {
        setFolders(md.folders);
        syncSessionsWithFolders(md.folders);
      } else {
        await loadMetadata();
      }

      showToast("success", "Files uploaded.");
    } catch (e2) {
      const msg = normalizeErr(e2);
      updateSession(folderId, { error: msg });
      showToast("error", msg);
    } finally {
      setUploadBusy(folderId, false);
      input.value = "";
    }
  }

  async function deleteFile(folderId, serverName) {
    setBusy((b) => ({ ...b, deleteFile: true }));
    updateSession(folderId, { error: "" });

    try {
      const res = await fetch(ENDPOINTS.deleteFile(folderId, serverName), { method: "DELETE" });
      if (!res.ok) {
        const t = await safeReadText(res);
        throw new Error(t || `Delete file failed: ${res.status}`);
      }
      const json = await res.json();
      if (!Array.isArray(json?.folders)) throw new Error("Invalid delete-file response: expected {folders:[]}");
      setFolders(json.folders);
      syncSessionsWithFolders(json.folders);
      showToast("success", "File deleted.");
    } catch (e) {
      const msg = normalizeErr(e);
      updateSession(folderId, { error: msg });
      showToast("error", msg);
    } finally {
      setBusy((b) => ({ ...b, deleteFile: false }));
    }
  }

  function toggleSort(col) {
    const s = getSession(selectedFolderId);
    const dir = s.sortConfig.key === col && s.sortConfig.direction === "asc" ? "desc" : "asc";
    updateSession(selectedFolderId, { sortConfig: { key: col, direction: dir } });
  }

  function cancelSearch(folderId, mode) {
    const k = keyFor(folderId, mode);

    const controller = abortRef.current[k];
    if (controller) {
      try {
        controller.abort();
      } catch {}
    }

    reqIdRef.current[k] = (reqIdRef.current[k] || 0) + 1;

    if (mode === "chat") updateSession(folderId, { searchingChat: false });
    else updateSession(folderId, { searchingTable: false });
  }

  // chat input enter-to-send
  function onChatInputKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleChatSearch();
    }
  }

  // ✅ TABLE SEARCH: no chat side effects
  async function handleTableSearch() {
    const folder = selectedFolder;
    const folderId = folder?.id;
    if (!folderId) return showToast("error", "No folder selected.");

    const s0 = getSession(folderId);

    // cancel
    if (s0.searchingTable) {
      cancelSearch(folderId, "table");
      showToast("info", "Table search cancelled.");
      return;
    }

    const q = String(s0.tableQuery || "").trim();
    const qCheck = validateQuery(q);
    if (!qCheck.ok) return showToast("error", qCheck.msg);

    const files = (folder?.files || []).map((f) => f.server_name).filter(Boolean);
    if (!files.length) return showToast("error", "Selected folder has no uploaded files.");

    const k = keyFor(folderId, "table");
    const nextId = (reqIdRef.current[k] || 0) + 1;
    reqIdRef.current[k] = nextId;

    if (abortRef.current[k]) {
      try {
        abortRef.current[k].abort();
      } catch {}
    }
    const controller = new AbortController();
    abortRef.current[k] = controller;

    updateSession(folderId, { searchingTable: true, error: "", currentPage: 1 });

    try {
      const payload = { query: q, folder_id: folderId, files };

      const res = await fetch(ENDPOINTS.search, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const t = await safeReadText(res);
        throw new Error(t || `Search failed: ${res.status}`);
      }

      const json = await res.json();
      const data = json?.LLMRESPONSE;
      if (!Array.isArray(data)) throw new Error("Invalid response: expected {LLMRESPONSE: []}");

      const normalized = data.map((x, i) =>
        x && typeof x === "object" && !Array.isArray(x) ? x : { value: String(x ?? ""), _index: i + 1 }
      );

      if (reqIdRef.current[k] !== nextId) return;

      updateSession(folderId, { rows: normalized, sortConfig: { key: null, direction: "asc" } });

      showToast("success", `Results: ${normalized.length}`);
    } catch (e) {
      if (String(e?.name) === "AbortError") return;
      if (reqIdRef.current[k] !== nextId) return;

      const msg = normalizeErr(e);
      updateSession(folderId, { rows: [], error: msg });
      showToast("error", msg);
    } finally {
      if (reqIdRef.current[k] === nextId) updateSession(folderId, { searchingTable: false });
    }
  }

  // ✅ CHAT SEARCH: pushes chat + clears chatQuery only + sends chat history to backend
  async function handleChatSearch() {
    const folder = selectedFolder;
    const folderId = folder?.id;
    if (!folderId) return showToast("error", "No folder selected.");

    const s0 = getSession(folderId);

    // cancel
    if (s0.searchingChat) {
      cancelSearch(folderId, "chat");
      showToast("info", "Chat search cancelled.");
      return;
    }

    const q = String(s0.chatQuery || "").trim();
    const qCheck = validateQuery(q);
    if (!qCheck.ok) return showToast("error", qCheck.msg);

    const files = (folder?.files || []).map((f) => f.server_name).filter(Boolean);
    if (!files.length) return showToast("error", "Selected folder has no uploaded files.");

    // push user msg
    pushChat(folderId, "user", q);

    // clear chat textbox only
    updateSession(folderId, { chatQuery: "" });
    try {
      chatInputRef.current?.focus?.();
    } catch {}

    const k = keyFor(folderId, "chat");
    const nextId = (reqIdRef.current[k] || 0) + 1;
    reqIdRef.current[k] = nextId;

    if (abortRef.current[k]) {
      try {
        abortRef.current[k].abort();
      } catch {}
    }
    const controller = new AbortController();
    abortRef.current[k] = controller;

    updateSession(folderId, { searchingChat: true, error: "" });

    try {
      // send conversation context
      const chatNow = getSession(folderId).chat || [];
      const messages = chatNow.map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      }));

      const payload = { query: q, folder_id: folderId, files, messages };

      const res = await fetch(ENDPOINTS.chatSearch, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const t = await safeReadText(res);
        throw new Error(t || `Chat search failed: ${res.status}`);
      }

      const json = await res.json();

      if (reqIdRef.current[k] !== nextId) return;

      // optional: update table rows too (nice for switching to Table)
      const data = json?.LLMRESPONSE;
      if (Array.isArray(data)) {
        const normalized = data.map((x, i) =>
          x && typeof x === "object" && !Array.isArray(x) ? x : { value: String(x ?? ""), _index: i + 1 }
        );
        updateSession(folderId, { rows: normalized, sortConfig: { key: null, direction: "asc" } });
      }

      const assistantText = String(json?.assistant_text || rowsToChatText(json?.LLMRESPONSE || []));
      pushChat(folderId, "assistant", assistantText);

      showToast("success", "Answered.");
    } catch (e) {
      if (String(e?.name) === "AbortError") return;
      if (reqIdRef.current[k] !== nextId) return;

      const msg = normalizeErr(e);
      pushChat(folderId, "assistant", `❌ ${msg}`);
      showToast("error", msg);
    } finally {
      if (reqIdRef.current[k] === nextId) updateSession(folderId, { searchingChat: false });
    }
  }

  function exportToExcel() {
    if (!sortedRows.length) return showToast("error", "No data to export.");
    try {
      const ws = XLSX.utils.json_to_sheet(sortedRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Results");
      saveAs(new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })]), "LRC_TextSeeker.xlsx");
      showToast("success", "Exported Excel.");
    } catch (e) {
      showToast("error", normalizeErr(e));
    }
  }

  function clearChat(folderId) {
    updateSession(folderId, { chat: [] });
    showToast("info", "Chat cleared.");
  }

  function switchTab(mode) {
    updateSession(selectedFolderId, { viewMode: mode });
    try {
      chatInputRef.current?.focus?.();
    } catch {}
  }

  return (
    <div style={styles.page}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        textarea::placeholder { color: #9ca3af; font-weight: 400; }
      `}</style>

      {toast && (
        <div
          style={{
            ...styles.toast,
            ...(toast.type === "success"
              ? styles.toastSuccess
              : toast.type === "error"
              ? styles.toastError
              : styles.toastInfo),
          }}
        >
          {toast.msg}
        </div>
      )}

      {/* HEADER */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.brand}>LRC.TextSeeker</div>

          <div style={styles.headerRight} data-profile-root>
            <div style={styles.profileBtn} onClick={() => setProfileOpen((v) => !v)} role="button">
              <div style={styles.avatar}>{initials(user?.name)}</div>
              <div style={styles.profileText}>
                <div style={styles.profileName}>{user?.name || "User"}</div>
                <div style={styles.profileRole}>{user?.role || "User"}</div>
              </div>
              <div style={styles.caret}>▾</div>
            </div>

            {profileOpen && (
              <div style={styles.profileMenu}>
                <div style={styles.menuHeader}>
                  <div style={styles.menuName}>{user?.name || "User"}</div>
                  <div style={styles.menuEmail}>{user?.email || "—"}</div>
                </div>
                <div style={styles.menuDivider} />
                <button style={styles.menuItem} onClick={() => showToast("info", "Profile (placeholder)")}>
                  Profile
                </button>
                <button style={styles.menuItem} onClick={() => showToast("info", "Settings (placeholder)")}>
                  Settings
                </button>
                <div style={styles.menuDivider} />
                <button style={{ ...styles.menuItem, color: "#b91c1c" }} onClick={() => showToast("info", "Logout")}>
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* BODY */}
      <div style={styles.layout}>
        {/* LEFT */}
        <aside style={styles.sidebar}>
          <div style={styles.sidebarHeader}>
            <div style={styles.sidebarTitle}>Explorer</div>
            <button onClick={loadMetadata} style={styles.smallBtn} disabled={busy.metadata} title="Reload from server">
              {busy.metadata ? "Loading..." : "Reload"}
            </button>
          </div>

          <div style={styles.folderCreateRow}>
            <input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="New folder name"
              style={styles.folderInput}
              maxLength={RULES.folderNameMax}
              disabled={busy.metadata || busy.createFolder || busy.deleteFolder}
            />
            <button
              onClick={createFolder}
              style={styles.smallBtn}
              disabled={busy.metadata || busy.createFolder || busy.deleteFolder || !newFolderName.trim()}
            >
              {busy.createFolder ? "Creating..." : "Create"}
            </button>
          </div>

          <div style={styles.sectionLabel}>Folders</div>
          <div style={styles.folderList}>
            {folders.map((f) => {
              const s = getSession(f.id);
              const folderIsSearching = s.searchingChat || s.searchingTable;
              const folderIsUploading = isUploadBusy(f.id);

              return (
                <div
                  key={f.id}
                  style={{ ...styles.folderItem, ...(f.id === selectedFolderId ? styles.folderItemActive : {}) }}
                  onClick={() => setSelectedFolderId(f.id)}
                  title={f.name}
                >
                  <div style={styles.folderLeft}>
                    <span style={styles.folderIcon}>📁</span>
                    <span style={styles.folderNameRow}>{f.name}</span>
                    <span style={styles.folderCount}>{(f.files || []).length}</span>
                    {(folderIsSearching || folderIsUploading) && (
                      <span title={folderIsSearching ? "Searching…" : "Uploading…"} style={{ fontSize: 12 }}>
                        ⏳
                      </span>
                    )}
                  </div>

                  {f.id !== "root" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteFolder(f.id);
                      }}
                      style={styles.iconBtn}
                      disabled={disableFolderDelete}
                      title="Delete folder"
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div style={styles.sectionLabel}>Files in “{selectedFolder?.name}”</div>

          <div style={styles.uploadRow}>
            <label style={{ ...styles.uploadBtn, opacity: disableUploadCurrentFolder ? 0.6 : 1 }}>
              + Add Files
              <input
                type="file"
                multiple
                onChange={uploadFiles}
                style={{ display: "none" }}
                disabled={disableUploadCurrentFolder}
              />
            </label>

            {isUploadBusy(selectedFolderId) && (
              <div style={styles.uploadStatus}>
                <span style={styles.smallSpinner} />
                Uploading…
              </div>
            )}
          </div>

          <div style={styles.fileList}>
            {(selectedFolder?.files || []).length ? (
              selectedFolder.files.map((f) => (
                <div key={f.server_name} style={styles.fileItem} title={f.original_name}>
                  <div style={styles.fileMeta}>
                    <div style={styles.fileName}>{f.original_name}</div>
                    <div style={styles.fileSize}>
                      {prettyBytes(f.size)}
                      <span style={styles.badgeOk}>Uploaded</span>
                    </div>
                  </div>

                  <button
                    onClick={() => deleteFile(selectedFolder.id, f.server_name)}
                    style={styles.iconBtn}
                    disabled={disableDeleteFile}
                    title="Delete file"
                  >
                    ✕
                  </button>
                </div>
              ))
            ) : (
              <div style={styles.fileEmpty}>No files in this folder</div>
            )}
          </div>
        </aside>

        {/* RIGHT */}
        <main style={styles.main}>
          {/* MODE TABS */}
          <div style={styles.topBar}>
            <div style={styles.pills}>
              <button style={{ ...styles.pill, ...(viewMode === "chat" ? styles.pillActive : {}) }} onClick={() => switchTab("chat")}>
                Chatbot
              </button>
              <button style={{ ...styles.pill, ...(viewMode === "table" ? styles.pillActive : {}) }} onClick={() => switchTab("table")}>
                Table
              </button>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {viewMode === "chat" && (
                <button style={styles.smallBtn} onClick={() => clearChat(selectedFolderId)} disabled={!chat.length}>
                  Clear chat
                </button>
              )}
            </div>
          </div>

          {/* CHAT MODE */}
          {viewMode === "chat" && (
            <div style={styles.chatShell}>
              <div style={styles.chatScroll}>
                {!chat.length && !session.searchingChat && (
                  <div style={styles.emptyHint}>Ask a question below. Switch to Table tab to view grid results.</div>
                )}

                {chat.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      ...styles.chatRow,
                      justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                    }}
                  >
                    <div style={{ ...styles.bubble, ...(m.role === "user" ? styles.bubbleUser : styles.bubbleAssistant) }}>
                      <div style={styles.bubbleText}>{m.text}</div>
                      <div style={styles.bubbleMeta}>
                        <span>{m.role === "user" ? "You" : "Assistant"}</span>
                        <span style={styles.bubbleDot}>•</span>
                        <span>{m.ts}</span>
                      </div>
                    </div>
                  </div>
                ))}

                {session.searchingChat && (
                  <div style={{ ...styles.chatRow, justifyContent: "flex-start" }}>
                    <div style={{ ...styles.bubble, ...styles.bubbleAssistant }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={styles.spinner} />
                        <div style={{ fontWeight: 500 }}>Searching…</div>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, color: "#6b7280", fontWeight: 500 }}>
                        In “{selectedFolder?.name}” (press Cancel to stop)
                      </div>
                    </div>
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>

              <div style={styles.chatInputBar}>
                <div style={styles.chatInputInner}>
                  <textarea
                    ref={chatInputRef}
                    value={session.chatQuery}
                    onChange={(e) => updateSession(selectedFolderId, { chatQuery: e.target.value })}
                    onKeyDown={onChatInputKeyDown}
                    placeholder="Message LRC.TextSeeker…"
                    style={styles.chatTextarea}
                    maxLength={RULES.queryMax}
                  />

                  <button
                    onClick={handleChatSearch}
                    style={{
                      ...(session.searchingChat ? styles.btn : styles.primaryBtn),
                      ...(session.searchingChat ? { borderColor: "#d9d9e3" } : {}),
                      minWidth: 92,
                    }}
                    title={session.searchingChat ? "Cancel the running chat search" : "Send"}
                  >
                    {session.searchingChat ? "Cancel" : "Send"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TABLE MODE */}
          {viewMode === "table" && (
            <>
              <div style={styles.searchCard}>
                <div style={styles.searchBoxWrap}>
                  <textarea
                    value={session.tableQuery}
                    onChange={(e) => updateSession(selectedFolderId, { tableQuery: e.target.value })}
                    placeholder="Message LRC.TextSeeker…"
                    style={styles.searchTextarea}
                    maxLength={RULES.queryMax}
                  />

                  <div style={styles.searchActions}>
                    <button
                      onClick={handleTableSearch}
                      style={{
                        ...(session.searchingTable ? styles.btn : styles.primaryBtn),
                        ...(session.searchingTable ? { borderColor: "#d9d9e3" } : {}),
                      }}
                      title={session.searchingTable ? "Cancel the running search" : "Run search"}
                    >
                      {session.searchingTable ? "Cancel" : "Search"}
                    </button>

                    <button onClick={exportToExcel} style={styles.btn} disabled={!sortedRows.length}>
                      Export
                    </button>

                    <select
                      value={pageSize}
                      onChange={(e) => updateSession(selectedFolderId, { pageSize: Number(e.target.value), currentPage: 1 })}
                      style={styles.select}
                      title="Rows per page"
                    >
                      {PAGE_SIZE_OPTIONS.map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {error && <div style={styles.errorBox}>{error}</div>}

              {!session.searchingTable && !sortedRows.length && (
                <div style={styles.emptyCard}>
                  <div style={styles.emptyTitle}>No results yet</div>
                  <div style={styles.emptyText}>
                    1) Select folder on left
                    <br />
                    2) Upload files
                    <br />
                    3) Search
                  </div>
                </div>
              )}

              {session.searchingTable && (
                <div style={styles.loaderWrap}>
                  <div style={styles.spinner} />
                  <div style={styles.loaderText}>Searching in “{selectedFolder?.name}”… (click “Cancel” to stop)</div>
                </div>
              )}

              {!session.searchingTable && hasResults && (
                <>
                  <div style={styles.tableCard}>
                    <div style={styles.tableMeta}>
                      <div style={styles.tableTitle}>Results</div>
                      <div style={styles.tableSub}>{sortedRows.length} rows</div>
                    </div>

                    <div style={styles.tableScroll}>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            {columns.map((c) => (
                              <th key={c} style={styles.th} onClick={() => toggleSort(c)} title="Click to sort">
                                {c}
                                {sortConfig.key === c && (sortConfig.direction === "asc" ? " ↑" : " ↓")}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {paginatedRows.map((row, i) => (
                            <tr key={i} style={styles.tr}>
                              {columns.map((c) => (
                                <td key={c} style={styles.td}>
                                  {cellText(row?.[c])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div style={styles.pagination}>
                    <button
                      style={styles.pageBtn}
                      disabled={currentPage === 1}
                      onClick={() => updateSession(selectedFolderId, { currentPage: currentPage - 1 })}
                    >
                      Prev
                    </button>

                    {Array.from({ length: totalPages }).map((_, i) => (
                      <button
                        key={i}
                        onClick={() => updateSession(selectedFolderId, { currentPage: i + 1 })}
                        style={{ ...styles.pageBtn, ...(currentPage === i + 1 ? styles.activePage : {}) }}
                      >
                        {i + 1}
                      </button>
                    ))}

                    <button
                      style={styles.pageBtn}
                      disabled={currentPage === totalPages}
                      onClick={() => updateSession(selectedFolderId, { currentPage: currentPage + 1 })}
                    >
                      Next
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/* ===================== STYLES (unchanged from your file) ===================== */
const styles = {
  page: { width: "100%", minHeight: "100vh", background: "#f7f7f8", overflowX: "hidden" },

  toast: {
    position: "fixed",
    top: 14,
    right: 14,
    zIndex: 9999,
    maxWidth: 420,
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid #e5e7eb",
    boxShadow: "0 10px 20px rgba(0,0,0,0.08)",
    background: "#fff",
    fontSize: 13,
    fontWeight: 650,
    lineHeight: 1.35,
  },
  toastSuccess: { borderColor: "#bbf7d0", background: "#ecfdf5", color: "#065f46" },
  toastError: { borderColor: "#fecaca", background: "#fff1f2", color: "#9f1239" },
  toastInfo: { borderColor: "#e5e7eb", background: "#ffffff", color: "#111827" },

  header: { background: "#ffffff", borderBottom: "1px solid #ececf1" },
  headerInner: {
    width: "100%",
    padding: "12px 14px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  brand: { fontSize: 16, fontWeight: 700, color: "#111827" },

  headerRight: { position: "relative", display: "flex", alignItems: "center" },
  profileBtn: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid #ececf1",
    background: "#ffffff",
    cursor: "pointer",
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 999,
    border: "1px solid #ececf1",
    background: "#f7f7f8",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 12,
    color: "#374151",
  },
  profileText: { display: "flex", flexDirection: "column", lineHeight: 1.1 },
  profileName: { fontSize: 13, fontWeight: 650, color: "#111827" },
  profileRole: { fontSize: 12, color: "#6b7280", fontWeight: 500 },
  caret: { color: "#6b7280", fontSize: 12 },

  profileMenu: {
    position: "absolute",
    top: 52,
    right: 0,
    width: 240,
    borderRadius: 14,
    border: "1px solid #ececf1",
    background: "#ffffff",
    boxShadow: "0 10px 24px rgba(0,0,0,0.10)",
    overflow: "hidden",
    zIndex: 50,
  },
  menuHeader: { padding: 12 },
  menuName: { fontSize: 13, fontWeight: 650, color: "#111827" },
  menuEmail: { fontSize: 12, color: "#6b7280", marginTop: 4 },
  menuDivider: { height: 1, background: "#ececf1" },
  menuItem: {
    width: "100%",
    textAlign: "left",
    padding: "10px 12px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    color: "#111827",
  },

  layout: {
    width: "100%",
    padding: "10px 10px",
    display: "grid",
    gridTemplateColumns: "320px minmax(0, 1fr)",
    gap: 12,
    alignItems: "start",
  },

  sidebar: {
    position: "sticky",
    top: 10,
    alignSelf: "start",
    background: "#ffffff",
    borderRadius: 14,
    border: "1px solid #ececf1",
    padding: 12,
    height: "calc(100vh - 82px)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  sidebarHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  sidebarTitle: { fontSize: 14, fontWeight: 650, color: "#374151" },

  folderCreateRow: { display: "flex", gap: 8 },
  folderInput: {
    flex: 1,
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid #ececf1",
    fontSize: 13,
    color: "#111827",
    background: "#f7f7f8",
    outline: "none",
  },

  sectionLabel: {
    marginTop: 12,
    marginBottom: 8,
    fontSize: 11,
    fontWeight: 650,
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },

  folderList: { marginTop: 6, overflowY: "auto", paddingRight: 4 },

  folderItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 10px",
    borderRadius: 12,
    border: "1px solid #f0f0f4",
    background: "#f7f7f8",
    marginBottom: 10,
    cursor: "pointer",
  },
  folderItemActive: { background: "#ffffff", border: "1px solid #d9d9e3" },

  folderLeft: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  folderIcon: { fontSize: 14 },
  folderNameRow: {
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 150,
  },
  folderCount: {
    fontSize: 12,
    color: "#6b7280",
    border: "1px solid #ececf1",
    background: "#ffffff",
    borderRadius: 999,
    padding: "2px 8px",
    fontWeight: 600,
  },

  uploadRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" },
  uploadBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid #ececf1",
    background: "#ffffff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 650,
    color: "#374151",
  },
  uploadStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    fontWeight: 600,
    color: "#6b7280",
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid #ececf1",
    background: "#ffffff",
  },
  smallSpinner: {
    width: 14,
    height: 14,
    borderRadius: 999,
    border: "2px solid #ececf1",
    borderTopColor: "#111827",
    animation: "spin 1s linear infinite",
  },

  fileList: { marginTop: 10, overflowY: "auto", paddingRight: 4, flex: 1 },
  fileEmpty: { color: "#6b7280", fontSize: 13, paddingTop: 8 },

  fileItem: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    border: "1px solid #f0f0f4",
    background: "#f7f7f8",
    borderRadius: 12,
    padding: "10px 10px",
    marginBottom: 10,
  },
  fileMeta: { minWidth: 0, flex: 1 },
  fileName: {
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 220,
  },
  fileSize: { fontSize: 12, color: "#6b7280", marginTop: 2, fontWeight: 500 },

  badgeOk: {
    marginLeft: 8,
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 999,
    border: "1px solid #bbf7d0",
    background: "#ecfdf5",
    color: "#065f46",
    fontWeight: 650,
  },

  iconBtn: { border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: "#6b7280", padding: 4 },

  main: { width: "100%", minWidth: 0 },

  topBar: {
    padding: 10,
    background: "#ffffff",
    borderRadius: 14,
    border: "1px solid #ececf1",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 10,
  },

  pills: { display: "flex", gap: 8, alignItems: "center" },
  pill: {
    border: "1px solid #d9d9e3",
    background: "#ffffff",
    borderRadius: 999,
    padding: "8px 12px",
    fontWeight: 650,
    fontSize: 13,
    cursor: "pointer",
    color: "#374151",
  },
  pillActive: { background: "#111827", border: "1px solid #111827", color: "#ffffff" },

  /* CHAT SHELL */
  chatShell: {
    height: "calc(100vh - 170px)",
    display: "flex",
    flexDirection: "column",
    borderRadius: 14,
    border: "1px solid #ececf1",
    background: "#ffffff",
    overflow: "hidden",
  },
  chatScroll: { flex: 1, overflowY: "auto", padding: 14, background: "#ffffff" },
  chatRow: { display: "flex", marginBottom: 10, width: "100%" },

  bubble: {
    maxWidth: "78%",
    borderRadius: 16,
    padding: "10px 12px",
    border: "1px solid #ececf1",
    boxShadow: "0 6px 16px rgba(0,0,0,0.05)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  bubbleUser: { background: "#ffffff", color: "#111827", border: "1px solid #d9d9e3" },
  bubbleAssistant: { background: "#f7f7f8", color: "#111827", border: "1px solid #ececf1" },

  bubbleText: { fontSize: 14, lineHeight: 1.6, fontWeight: 400 },
  bubbleMeta: {
    marginTop: 8,
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    fontWeight: 500,
    opacity: 0.65,
  },
  bubbleDot: { opacity: 0.8 },

  chatInputBar: {
    borderTop: "1px solid #ececf1",
    background: "#ffffff",
    padding: 12,
  },
  chatInputInner: {
    background: "#ffffff",
    border: "1px solid #d9d9e3",
    borderRadius: 16,
    boxShadow: "0 6px 18px rgba(0,0,0,0.06)",
    padding: 10,
    display: "flex",
    gap: 10,
    alignItems: "flex-end",
  },
  chatTextarea: {
    width: "100%",
    minHeight: 52,
    maxHeight: 170,
    resize: "none",
    padding: "12px 12px",
    borderRadius: 14,
    border: "1px solid #ececf1",
    fontSize: 14,
    lineHeight: 1.45,
    fontFamily: "inherit",
    background: "#f7f7f8",
    color: "#111827",
    outline: "none",
  },

  /* TABLE MODE (original layout restored) */
  searchCard: { padding: 12, background: "transparent", borderRadius: 14, marginBottom: 12 },
  searchBoxWrap: {
    background: "#ffffff",
    border: "1px solid #d9d9e3",
    borderRadius: 16,
    boxShadow: "0 4px 16px rgba(0,0,0,0.06)",
    padding: 12,
  },
  searchTextarea: {
    width: "100%",
    minHeight: 110,
    resize: "vertical",
    padding: "14px 14px",
    borderRadius: 14,
    border: "1px solid #ececf1",
    fontSize: 15,
    lineHeight: 1.55,
    fontFamily: "inherit",
    background: "#f7f7f8",
    color: "#111827",
    outline: "none",
  },
  searchActions: {
    marginTop: 10,
    display: "flex",
    gap: 10,
    alignItems: "center",
    justifyContent: "flex-end",
    flexWrap: "wrap",
  },

  btn: {
    background: "#ffffff",
    border: "1px solid #d9d9e3",
    borderRadius: 12,
    padding: "10px 14px",
    cursor: "pointer",
    height: 40,
    fontWeight: 650,
    color: "#374151",
  },
  primaryBtn: {
    background: "#111827",
    border: "1px solid #111827",
    borderRadius: 12,
    padding: "10px 14px",
    cursor: "pointer",
    height: 40,
    fontWeight: 650,
    color: "#ffffff",
  },
  smallBtn: {
    background: "#ffffff",
    border: "1px solid #d9d9e3",
    borderRadius: 12,
    padding: "8px 10px",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 650,
    color: "#374151",
  },
  select: {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid #d9d9e3",
    background: "#ffffff",
    cursor: "pointer",
    height: 40,
    fontWeight: 650,
    color: "#374151",
  },

  errorBox: {
    background: "#fff1f2",
    border: "1px solid #fecaca",
    color: "#9f1239",
    padding: 12,
    borderRadius: 12,
    marginBottom: 12,
    fontSize: 13,
    fontWeight: 650,
    lineHeight: 1.4,
    whiteSpace: "pre-wrap",
  },

  emptyCard: { background: "#ffffff", border: "1px solid #ececf1", borderRadius: 14, padding: 16 },
  emptyTitle: { fontSize: 14, fontWeight: 650, marginBottom: 6, color: "#111827" },
  emptyText: { fontSize: 13, color: "#6b7280", lineHeight: 1.6, fontWeight: 500 },

  emptyHint: {
    border: "1px dashed #d9d9e3",
    background: "#f7f7f8",
    borderRadius: 14,
    padding: 14,
    color: "#374151",
    fontSize: 13,
    fontWeight: 500,
    marginBottom: 12,
  },

  loaderWrap: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderRadius: 14,
    border: "1px solid #ececf1",
    background: "#ffffff",
  },
  spinner: {
    width: 18,
    height: 18,
    borderRadius: 999,
    border: "3px solid #ececf1",
    borderTopColor: "#111827",
    animation: "spin 1s linear infinite",
  },
  loaderText: { fontSize: 13, fontWeight: 650, color: "#111827" },

  tableCard: { background: "#ffffff", borderRadius: 14, border: "1px solid #ececf1", overflow: "hidden" },
  tableMeta: {
    padding: "12px 14px",
    borderBottom: "1px solid #ececf1",
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
  },
  tableTitle: { fontSize: 13, fontWeight: 650, color: "#111827" },
  tableSub: { fontSize: 12, fontWeight: 500, color: "#6b7280" },

  tableScroll: { overflowX: "auto", overflowY: "hidden", width: "100%" },
  table: { width: "100%", borderCollapse: "collapse", minWidth: 900 },

  th: {
    padding: "10px 12px",
    background: "#f7f7f8",
    borderBottom: "1px solid #ececf1",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
    textAlign: "left",
    fontWeight: 650,
    color: "#374151",
  },
  tr: { background: "#ffffff" },
  td: {
    padding: "10px 12px",
    borderBottom: "1px solid #f0f0f4",
    fontSize: 12,
    whiteSpace: "nowrap",
    fontWeight: 400,
    color: "#111827",
  },

  pagination: { display: "flex", justifyContent: "center", gap: 8, marginTop: 12, flexWrap: "wrap" },
  pageBtn: {
    minWidth: 36,
    height: 36,
    borderRadius: 10,
    border: "1px solid #d9d9e3",
    background: "#ffffff",
    cursor: "pointer",
    fontWeight: 650,
    color: "#374151",
  },
  activePage: { background: "#f7f7f8", border: "1px solid #d9d9e3" },
};
