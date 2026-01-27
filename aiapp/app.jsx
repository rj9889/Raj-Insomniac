// src/App.jsx  (React frontend - Folder-specific search state + non-blocking folder navigation)
// ------------------------------------------------------------
// Install:
//   npm i xlsx file-saver
//
// Run (Vite):
//   npm install
//   npm run dev
// ------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";

/* ===================== CONFIG ===================== */
const API_BASE = "http://127.0.0.1:8000"; // ✅ browser must use 127.0.0.1, not 0.0.0.0

const ENDPOINTS = {
  me: `${API_BASE}/me`,
  metadata: `${API_BASE}/metadata`,
  createFolder: `${API_BASE}/folders`,
  deleteFolder: (folderId) => `${API_BASE}/folders/${folderId}`,
  upload: `${API_BASE}/upload`,
  deleteFile: (folderId, serverName) =>
    `${API_BASE}/folders/${folderId}/files?server_name=${encodeURIComponent(serverName)}`,
  search: `${API_BASE}/search`,
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

/* ===================== PER-FOLDER SESSION HELPERS ===================== */
function defaultSession() {
  return {
    query: "",
    rows: [],
    sortConfig: { key: null, direction: "asc" },
    pageSize: 10,
    currentPage: 1,
    error: "",
    searching: false,
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

  // ✅ Folder-specific search state (requirement)
  const [folderSearch, setFolderSearch] = useState({}); // { [folderId]: session }
  const searchAbortByFolderRef = useRef({}); // { [folderId]: AbortController }

  // Busy flags (keep search out of global busy; search is per folder)
  const [busy, setBusy] = useState({
    metadata: false,
    createFolder: false,
    deleteFolder: false,
    upload: false,
    deleteFile: false,
  });

  const selectedFolder = useMemo(
    () => folders.find((f) => f.id === selectedFolderId) || folders[0],
    [folders, selectedFolderId]
  );

  function getSession(folderId) {
    return folderSearch[folderId] || defaultSession();
  }

  function updateSession(folderId, patch) {
    setFolderSearch((prev) => ({
      ...prev,
      [folderId]: { ...defaultSession(), ...prev[folderId], ...patch },
    }));
  }

  // Derived per-folder UI state
  const session = getSession(selectedFolderId);
  const query = session.query;
  const filteredRows = session.rows;
  const sortConfig = session.sortConfig;
  const pageSize = session.pageSize;
  const currentPage = session.currentPage;
  const error = session.error;
  const isSearching = session.searching;

  const columns = useMemo(() => {
    if (!filteredRows.length) return [];
    const set = new Set();
    for (const r of filteredRows) {
      if (r && typeof r === "object" && !Array.isArray(r)) {
        Object.keys(r).forEach((k) => set.add(k));
      }
    }
    return Array.from(set);
  }, [filteredRows]);

  const sortedRows = useMemo(() => {
    if (!sortConfig.key) return filteredRows;
    const key = sortConfig.key;
    const dir = sortConfig.direction;

    const arr = [...filteredRows];
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
  }, [filteredRows, sortConfig]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const paginatedRows = sortedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const hasResults = paginatedRows.length > 0;

  // ✅ Do NOT block folder navigation due to searches/uploads
  const disableFolderNav = busy.metadata || busy.createFolder || busy.deleteFolder;
  const disableFileOps = busy.upload || busy.deleteFile || busy.metadata || busy.createFolder || busy.deleteFolder;

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

  // Ensure sessions exist for folders and cleanup missing ones
  function syncSessionsWithFolders(newFolders) {
    const ids = new Set((newFolders || []).map((f) => f.id));
    setFolderSearch((prev) => {
      const next = { ...prev };
      // add sessions for new folders
      for (const id of ids) if (!next[id]) next[id] = defaultSession();
      // remove sessions for deleted folders
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
      // abort any pending folder searches
      for (const c of Object.values(searchAbortByFolderRef.current || {})) {
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

      // abort any search in deleted folder
      if (searchAbortByFolderRef.current[folderId]) {
        try {
          searchAbortByFolderRef.current[folderId].abort();
        } catch {}
        delete searchAbortByFolderRef.current[folderId];
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
    const check = validateFiles(input.files);
    if (!check.ok) {
      showToast("error", check.msg);
      input.value = "";
      return;
    }

    setBusy((b) => ({ ...b, upload: true }));
    updateSession(selectedFolderId, { error: "" });

    try {
      const form = new FormData();
      Array.from(input.files).forEach((f) => form.append("files", f));

      const res = await fetch(`${ENDPOINTS.upload}?folder_id=${encodeURIComponent(selectedFolderId)}`, {
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
      updateSession(selectedFolderId, { error: msg });
      showToast("error", msg);
    } finally {
      setBusy((b) => ({ ...b, upload: false }));
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

  async function handleSearch() {
    const folder = selectedFolder;
    const folderId = folder?.id;
    const s = getSession(folderId);

    const qCheck = validateQuery(s.query);
    if (!qCheck.ok) return showToast("error", qCheck.msg);

    const files = (folder?.files || []).map((f) => f.server_name).filter(Boolean);
    if (!folderId) return showToast("error", "No folder selected.");
    if (!files.length) return showToast("error", "Selected folder has no uploaded files.");

    // reset pagination only for this folder
    updateSession(folderId, { currentPage: 1, error: "" });

    // abort only THIS folder's prior search
    if (searchAbortByFolderRef.current[folderId]) {
      searchAbortByFolderRef.current[folderId].abort();
    }
    const controller = new AbortController();
    searchAbortByFolderRef.current[folderId] = controller;

    updateSession(folderId, { searching: true });

    try {
      const payload = {
        query: s.query.trim(),
        folder_id: folderId,
        files,
      };

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

      updateSession(folderId, {
        rows: normalized,
        sortConfig: { key: null, direction: "asc" },
      });

      showToast("success", `Results: ${normalized.length}`);
    } catch (e) {
      if (String(e?.name) === "AbortError") return;
      const msg = normalizeErr(e);
      updateSession(folderId, { rows: [], error: msg });
      showToast("error", msg);
    } finally {
      updateSession(folderId, { searching: false });
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

  return (
    <div style={styles.page}>
      {/* spinner keyframes */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
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
                <button
                  style={{ ...styles.menuItem, color: "#b91c1c" }}
                  onClick={() => showToast("info", "Logout (placeholder)")}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* BODY LAYOUT */}
      <div style={styles.layout}>
        {/* LEFT EXPLORER */}
        <aside style={styles.sidebar}>
          <div style={styles.sidebarHeader}>
            <div style={styles.sidebarTitle}>Explorer</div>
            <button
              onClick={loadMetadata}
              style={styles.smallBtn}
              disabled={busy.metadata}
              title="Reload from server"
            >
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
              const folderIsSearching = getSession(f.id).searching;
              return (
                <div
                  key={f.id}
                  style={{ ...styles.folderItem, ...(f.id === selectedFolderId ? styles.folderItemActive : {}) }}
                  onClick={() => !disableFolderNav && setSelectedFolderId(f.id)}
                  title={f.name}
                >
                  <div style={styles.folderLeft}>
                    <span style={styles.folderIcon}>📁</span>
                    <span style={styles.folderNameRow}>{f.name}</span>
                    <span style={styles.folderCount}>{(f.files || []).length}</span>
                    {folderIsSearching && <span title="Searching…" style={{ fontSize: 12 }}>⏳</span>}
                  </div>

                  {f.id !== "root" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteFolder(f.id);
                      }}
                      style={styles.iconBtn}
                      disabled={busy.metadata || busy.createFolder || busy.deleteFolder}
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

          {/* ✅ Upload button + simple status (no progress bar) */}
          <div style={styles.uploadRow}>
            <label style={{ ...styles.uploadBtn, opacity: disableFileOps ? 0.6 : 1 }}>
              + Add Files
              <input type="file" multiple onChange={uploadFiles} style={{ display: "none" }} disabled={disableFileOps} />
            </label>

            {busy.upload && (
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
                    disabled={disableFileOps}
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

        {/* RIGHT CONTENT */}
        <main style={styles.main}>
          <div style={styles.searchCard}>
            <div style={styles.searchBoxWrap}>
              <textarea
                value={query}
                onChange={(e) => updateSession(selectedFolderId, { query: e.target.value })}
                placeholder="Message LRC.TextSeeker…"
                style={styles.searchTextarea}
                disabled={false} // ✅ never block typing
                maxLength={RULES.queryMax}
              />

              <div style={styles.searchActions}>
                <button onClick={handleSearch} style={styles.primaryBtn} disabled={false}>
                  {isSearching ? "Searching..." : "Search"}
                </button>

                <button onClick={exportToExcel} style={styles.btn} disabled={!sortedRows.length}>
                  Export
                </button>

                <select
                  value={pageSize}
                  onChange={(e) => {
                    const size = Number(e.target.value);
                    updateSession(selectedFolderId, { pageSize: size, currentPage: 1 });
                  }}
                  style={styles.select}
                  disabled={false}
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

          {!isSearching && !sortedRows.length && (
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

          {isSearching && (
            <div style={styles.loaderWrap}>
              <div style={styles.spinner} />
              <div style={styles.loaderText}>Searching in “{selectedFolder?.name}”…</div>
            </div>
          )}

          {!isSearching && hasResults && (
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
        </main>
      </div>
    </div>
  );
}

/* ===================== STYLES (ChatGPT-like grey + clean) ===================== */
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

  uploadRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 6,
    flexWrap: "wrap",
  },
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

  iconBtn: {
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: 16,
    color: "#6b7280",
    padding: 4,
  },

  main: { width: "100%", minWidth: 0 },

  searchCard: {
    padding: 12,
    background: "transparent",
    borderRadius: 14,
    marginBottom: 12,
  },
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
  },

  emptyCard: { background: "#ffffff", border: "1px solid #ececf1", borderRadius: 14, padding: 16 },
  emptyTitle: { fontSize: 14, fontWeight: 650, marginBottom: 6, color: "#111827" },
  emptyText: { fontSize: 13, color: "#6b7280", lineHeight: 1.6, fontWeight: 500 },

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
