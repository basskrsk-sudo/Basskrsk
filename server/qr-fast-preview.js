'use strict';
function loadQrPreview(database, pointId, productKey, findDefaultGroomer) {
  const point = database.prepare("SELECT id,name,addr,city_id FROM points WHERE id=? AND active=1").get(String(pointId || ''));
  if (!point) return null;
  const key = String(productKey || '');
  if (!key || key.length > 200) return null;
  const product = database.prepare(
    'SELECT id,slug,name,category,icon,badge,img,"desc" AS "desc",comp,active FROM products ' +
    'WHERE (slug=? OR CAST(id AS TEXT)=?) AND active=1 AND archived_at IS NULL LIMIT 1'
  ).get(key, key);
  if (!product) return null;
  const variants = database.prepare(
    "SELECT v.id,v.weight,v.price,COALESCE(s.qty,0) AS qty " +
    "FROM product_variants v LEFT JOIN stock s ON s.variant_id=v.id AND s.point_id=? " +
    "WHERE v.product_id=? AND v.active=1 ORDER BY v.sort_order,v.id"
  ).all(point.id, product.id);
  if (!variants.length) return null;
  const partners = database.prepare(
    "SELECT id,full_name FROM partners WHERE point_id=? AND active=1 ORDER BY full_name"
  ).all(point.id);
  const suggestion = findDefaultGroomer(point.id);
  return {
    point,
    product: { ...product, active: true, variants: variants.map(v => ({
      ...v, active: true, stock: { [point.id]: v.qty },
    })) },
    partners,
    default_partner_id: suggestion.partner ? suggestion.partner.id : null,
    default_source: suggestion.source,
  };
}
module.exports = { loadQrPreview };
