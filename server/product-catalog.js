'use strict';
// Build the catalog using fixed-count SQL reads instead of 3+ reads per product.
// Public stock data stays live on EVERY request; purchase/payment flows are
// unchanged. Cost prices are only serialized for authenticated administrators.
const db=require('./db');
function buildCatalog(rows,includeCost,includeInactive,salesByProduct=new Map(),connection=db) {
  if(!rows.length)return [];
  const selected=new Set(rows.map(r=>Number(r.id)));
  const activeWhere=includeInactive ? '' :
    'WHERE p.active=1 AND p.archived_at IS NULL AND v.active=1';
  const variants=connection.prepare(
    'SELECT v.id,v.product_id,v.weight,v.price,v.cost_price,v.active,v.sort_order '+
    'FROM product_variants v JOIN products p ON p.id=v.product_id '+
    activeWhere+' ORDER BY v.product_id,v.sort_order'
  ).all();
  const byProduct=new Map(), visibleVariants=new Set();
  for(const v of variants) {
    if(!selected.has(Number(v.product_id)))continue;
    if(!byProduct.has(v.product_id))byProduct.set(v.product_id,[]);
    byProduct.get(v.product_id).push(v);
    visibleVariants.add(v.id);
  }

  const stockRows=connection.prepare(
    'SELECT s.variant_id,s.point_id,s.qty FROM stock s '+
    'JOIN product_variants v ON v.id=s.variant_id '+
    'JOIN products p ON p.id=v.product_id '+activeWhere
  ).all();
  const stock=new Map();
  for(const r of stockRows){
    if(!visibleVariants.has(r.variant_id))continue;
    if(!stock.has(r.variant_id))stock.set(r.variant_id,{});
    stock.get(r.variant_id)[r.point_id]=r.qty;
  }

  const reviewRows=connection.prepare(
    "SELECT product_id,COUNT(*) AS cnt,AVG(rating) AS avg_rating FROM ("+
    "SELECT product_id,rating FROM product_reviews WHERE status='approved' UNION ALL "+
    "SELECT product_id,rating FROM guest_product_reviews WHERE status='approved') "+
    "GROUP BY product_id"
  ).all();
  const reviews=new Map(reviewRows.map(r=>[Number(r.product_id),{
    review_count:r.cnt||0,
    review_avg:r.cnt ? Math.round(r.avg_rating*10)/10 : null,
  }]));
  return rows.map(p=>{
    let comp=[];
    try {comp=JSON.parse(p.comp);}catch(_){}
    const vs=byProduct.get(p.id)||[];
    return {
      id:p.id,slug:p.slug,name:p.name,category:p.category,icon:p.icon,
      badge:p.badge,img:p.img,desc:p.desc,comp,
      pet_suitability:p.pet_suitability||'',purpose:p.purpose||'',
      restrictions:p.restrictions||'',active:!!p.active,
      archived:!!p.archived_at,archived_at:p.archived_at||null,
      ...(reviews.get(Number(p.id))||{review_count:0,review_avg:null}),
      variants:vs.map(v=>Object.assign({
        id:v.id,weight:v.weight,price:v.price,active:!!v.active,
        stock:stock.get(v.id)||{},
      },includeCost?{cost_price:v.cost_price}:{})),
      sales_count:salesByProduct.get(Number(p.id))||0,
    };
  }).filter(p=>includeInactive||p.variants.length>0);
}
module.exports={buildCatalog};
