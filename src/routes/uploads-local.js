// src/routes/uploads-local.js
// LOCAL FILE SYSTEM UPLOADS (DEV / SMALL DEPLOYMENTS)
// Requires: req.user from jwtAuthMiddleware, req.db optional
// Only admin/editor allowed to upload/delete images

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

/* -----------------------------------------------------------------------
   Helpers: Role check
------------------------------------------------------------------------ */
function requireEditorOrAdmin(req, res) {
  if (!req.user) return res.status(401).json({ ok: false, error: "unauthorized" });
  const role = Number(req.user.role); // admin=1, editor=2
  if (role === 1 || role === 2) return null;
  return res.status(403).json({ ok: false, error: "forbidden" });
}

/* -----------------------------------------------------------------------
   Upload root & spaces
------------------------------------------------------------------------ */
const UPLOAD_ROOT =
  process.env.LOCAL_UPLOAD_DIR ||
  path.join(__dirname, "..", "..", "uploads"); // project_root/src/uploads

const SPACES = {
  products: path.join(UPLOAD_ROOT, "products"),
  blogs: path.join(UPLOAD_ROOT, "blogs")
};

// Ensure directories exist
(async () => {
  try {
    for (const dir of Object.values(SPACES)) {
      await fs.mkdir(dir, { recursive: true });
      console.log(`[uploads-local] ensured directory exists: ${dir}`);
    }
  } catch (e) {
    console.warn("[uploads-local] cannot create upload directory:", e?.message || e);
  }
})();

/* -----------------------------------------------------------------------
   Multer storage
------------------------------------------------------------------------ */
function createMulterForSpace(spaceDir) {
  return multer.diskStorage({
    destination(req, file, cb) {
      cb(null, spaceDir);
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase();
      const filename = `${Date.now()}-${uuidv4()}${ext}`;
      cb(null, filename);
    }
  });
}

function uploadMiddlewareFor(spaceKey) {
  const dir = SPACES[spaceKey];
  const storage = createMulterForSpace(dir);
  return multer({
    storage,
    limits: {
      fileSize: parseInt(process.env.LOCAL_UPLOAD_MAX_BYTES || "5242880", 10) // 5MB
    },
    fileFilter(req, file, cb) {
      if (!file.mimetype || !file.mimetype.startsWith("image/")) {
        return cb(new Error("invalid_file_type"));
      }
      cb(null, true);
    }
  });
}

/* -----------------------------------------------------------------------
   Helper: build public URL
------------------------------------------------------------------------ */
function buildPublicUrl(req, space, filename) {
  // during development prefer a relative path so Vite proxy can handle it
  if (process.env.NODE_ENV !== 'production') {
    return `/uploads/${encodeURIComponent(space)}/${encodeURIComponent(filename)}`;
  }
  const publicBase =
    process.env.APP_BACKEND_URL ||
    `${req.protocol}://${req.get("host")}`;
  const relPath = `/uploads/${encodeURIComponent(space)}/${encodeURIComponent(filename)}`;
  return publicBase.replace(/\/$/, "") + relPath;
}

/* -----------------------------------------------------------------------
   Helper: verify file readable
------------------------------------------------------------------------ */
async function waitForFileReadable(filePath, attempts = 6, delayMs = 150) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.access(filePath, fsSync.constants.R_OK);
      return true;
    } catch (e) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return false;
}

/* -----------------------------------------------------------------------
   Routes per space
------------------------------------------------------------------------ */
for (const space of Object.keys(SPACES)) {
  const upload = uploadMiddlewareFor(space);

  // POST /api/uploads/<space>
  router.post(`/${space}`, (req, res) => {
    if (requireEditorOrAdmin(req, res)) return;

    upload.single("file")(req, res, async (err) => {
      if (err) {
        console.error(`[uploads-local:${space}] multer error:`, err);
        return res.status(400).json({ ok: false, error: err.message || "upload_error" });
      }

      if (!req.file) return res.status(400).json({ ok: false, error: "no_file" });

      try {
        const filename = req.file.filename;
        const filePath = req.file.path;

        const ok = await waitForFileReadable(filePath, 8, 125);
        const publicUrl = buildPublicUrl(req, space, filename);

        if (!ok) {
          console.warn(`[uploads-local:${space}] file not readable immediately: ${filePath}`);
          return res.status(202).json({
            ok: true,
            filename,
            path: filePath,
            publicUrl,
            public_url: publicUrl,
            url: publicUrl,
            space,
            note: "file_not_yet_readable_now; try again shortly"
          });
        }

        return res.json({
          ok: true,
          filename,
          path: filePath,
          publicUrl,
          public_url: publicUrl,
          url: publicUrl,
          space
        });
      } catch (err) {
        console.error(`[uploads-local:${space}] error:`, err);
        return res.status(500).json({ ok: false, error: "server_error", detail: err.message });
      }
    });
  });

  // GET /api/uploads/<space>/list
  router.get(`/${space}/list`, (req, res) => {
    if (requireEditorOrAdmin(req, res)) return;

    try {
      const dir = SPACES[space];
      const files = fsSync.existsSync(dir) ? fsSync.readdirSync(dir).slice(0, 500) : [];

      // In dev return relative URLs so frontend proxy /uploads can be used.
      const base = (process.env.NODE_ENV !== 'production')
        ? ''
        : (process.env.APP_BACKEND_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, '');

      const rows = files.map(f => ({
        filename: f,
        url: `${base}/uploads/${encodeURIComponent(space)}/${encodeURIComponent(f)}`
      }));
      return res.json({ ok: true, files: rows });
    } catch (err) {
      console.error(`[uploads-local:${space}] list error:`, err);
      return res.status(500).json({ ok: false, error: "server_error", detail: err.message });
    }
  });

  // DELETE /api/uploads/<space>/:filename
  router.delete(`/${space}/:filename`, async (req, res) => {
    if (requireEditorOrAdmin(req, res)) return;

    const filename = req.params.filename;
    if (!filename) return res.status(400).json({ ok: false, error: "filename_required" });

    const filePath = path.join(SPACES[space], filename);

    try {
      if (!fsSync.existsSync(filePath)) return res.status(404).json({ ok: false, error: "not_found" });
      await fs.unlink(filePath);
      return res.json({ ok: true });
    } catch (err) {
      console.error(`[uploads-local:${space}] delete error:`, err);
      return res.status(500).json({ ok: false, error: "server_error", detail: err.message });
    }
  });
}

/* -----------------------------------------------------------------------
   Mounted by index.js at /api/uploads
------------------------------------------------------------------------ */
module.exports = router;
