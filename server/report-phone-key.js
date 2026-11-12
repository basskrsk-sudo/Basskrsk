'use strict';

// The checkout stores phones as digits, but legacy orders contain common
// formatting separators. Use only SQLite built-ins so the expression can be
// indexed without creating an SQLite function.
const SEPARATORS = ["' '", "'+'", "'-'", "'('", "')'", "'.'", "'/'",
  "'_'", "','", "':'", "';'",
  "char(9)", "char(10)", "char(13)",
  "char(160)", "char(8239)", "char(8209)", "char(8211)", "char(8212)"];
const stripped = SEPARATORS.reduce(
  (expr, separator) => `replace(${expr}, ${separator}, '')`,
  "COALESCE(customer_phone, '')"
);
const PAID_PHONE_KEY_SQL = `substr(${stripped}, -10)`;
module.exports = { PAID_PHONE_KEY_SQL };
