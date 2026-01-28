// src/middleware/permissions.js

/**
 * Roles in your system:
 * 1 = Admin
 * 2 = Editor (read-only for blogs)
 * 3 = User
 * 4 = Guest (anonymous)
 */

const ROLE = {
  ADMIN: 1,
  EDITOR: 2,
  USER: 3,
  GUEST: 4,
};

/**
 * PERMISSIONS REGISTRY
 * Only admin can create/update/delete/publish blogs.
 * Everyone can read, like, comment.
 */

const PERMISSIONS = {
  "blog.create":   [ROLE.ADMIN],
  "blog.update":   [ROLE.ADMIN],
  "blog.delete":   [ROLE.ADMIN],
  "blog.publish":  [ROLE.ADMIN],
  "blog.upload":   [ROLE.ADMIN],      // images
  "blog.comment":  [ROLE.ADMIN, ROLE.USER, ROLE.EDITOR], 
  "blog.like":     [ROLE.ADMIN, ROLE.USER, ROLE.EDITOR],
  "blog.read":     [ROLE.ADMIN, ROLE.EDITOR, ROLE.USER, ROLE.GUEST],
};

/**
 * hasPermission("blog.create")
 */
function hasPermission(permissionName) {
  return (req, res, next) => {
    const allowedRoles = PERMISSIONS[permissionName];

    if (!allowedRoles) {
      console.error(`Unknown permission: ${permissionName}`);
      return res.status(500).json({ error: "server_error" });
    }

    const user = req.user;

    if (!user) {
      // anonymous = role 4 guest
      if (allowedRoles.includes(ROLE.GUEST)) return next();
      return res.status(403).json({ error: "not_allowed" });
    }

    if (allowedRoles.includes(user.role)) return next();

    return res.status(403).json({ error: "forbidden" });
  };
}

module.exports = { hasPermission, ROLE };
