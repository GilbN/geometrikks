/**
 * Methods in the IANA HTTP Method Registry, with common methods first in the
 * filter. Registry snapshot verified 2026-09-02; keep this in sync with the
 * independent registry snapshot tests.
 * https://www.iana.org/assignments/http-methods/http-methods.xhtml
 */
export const HTTP_METHODS = [
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE",
  "ACL", "BASELINE-CONTROL", "BIND", "CHECKIN", "CHECKOUT", "COPY", "LABEL", "LINK",
  "LOCK", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MKREDIRECTREF", "MKWORKSPACE",
  "MOVE", "ORDERPATCH", "PRI", "PROPFIND", "PROPPATCH", "QUERY", "REBIND", "REPORT",
  "SEARCH", "UNBIND", "UNCHECKOUT", "UNLINK", "UNLOCK", "UPDATE", "UPDATEREDIRECTREF",
  "VERSION-CONTROL", "*",
] as const
