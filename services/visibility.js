// Ownership and visibility for user-made objects (charts, dashboards, reports), architecture 9:
// private | account_view | account_edit. Superadmins see and edit everything.
const LEVELS = ["private", "account_view", "account_edit"];

function canSee(row, user) { return row.owner_user_id === user.id || row.visibility !== "private" || !!user.is_superadmin; }
function canEdit(row, user) { return row.owner_user_id === user.id || row.visibility === "account_edit" || !!user.is_superadmin; }
function isOwner(row, user) { return row.owner_user_id === user.id || !!user.is_superadmin; }
function normalize(value, fallback) { return LEVELS.includes(value) ? value : (fallback || "private"); }

module.exports = { LEVELS, canSee, canEdit, isOwner, normalize };
