'use strict';

// Record is based on paid CUSTOMER orders grouped by their UTC-created date
// converted to the Krasnoyarsk calendar day (UTC+07:00).
// No synchronous historical scan runs on each checkout: compute a completed
// day once in the Partner Club worker, plus on-demand admin analytics.
const DAY_MS=86400000;
const OFFSET_MS=7*3600000;
const toSql=ms=>new Date(ms).toISOString().slice(0,19).replace('T',' ');
function bounds(now=new Date()){
  const today=new Date(now.getTime()+OFFSET_MS).toISOString().slice(0,10);
  const start=Date.parse(today+'T00:00:00Z')-OFFSET_MS;
  return {
    today,
    yesterday:new Date(Date.parse(today+'T00:00:00Z')-DAY_MS).toISOString().slice(0,10),
    yesterdayStart:toSql(start-DAY_MS),
    todayStart:toSql(start),
    tomorrowStart:toSql(start+DAY_MS),
  };
}
function validSales(alias=''){
  const a=alias?alias+'.':'';
  return [
    a+"status='paid'",
    a+"yookassa_payment_id IS NOT NULL",
    "COALESCE("+a+"is_partner_self_order,0)=0",
    "COALESCE("+a+"refund_status,'')!='refunded'",
    a+"total>COALESCE("+a+"refunded_amount,0)",
  ].join(' AND ');
}
function message(day,count,previous,leader){
  const date=day.split('-').reverse().join('.');
  const point=String(leader?.point_name||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,90);
  return [
    '🏆 Новый рекорд ХвостМаркета по количеству продаж за день!',
    '',
    '📅 '+date+' · время Красноярска',
    '',
    '🐾 Продаж за день: '+count,
    '🥈 Предыдущий рекорд: '+previous,
    '🚀 Превышение: +'+(count-previous),
    point?'🏪 Лидер дня: «'+point+'» — '+leader.sales+' '+
      ((n)=>n%10===1 && n%100!==11?'продажа':
        n%10>=2 && n%10<=4 && (n%100<12||n%100>14)?'продажи':'продаж')(Number(leader.sales)):'',
    '',
    '🎉 Поздравляем партнёров! Кто поможет сети побить этот рекорд? 💚',
  ].filter(BooleanOrBlank).join('\n');
}
function BooleanOrBlank(line){return line!==null&&line!==undefined;}
function createDailySalesRecords(db){
  db.exec("CREATE TABLE IF NOT EXISTS partner_club_daily_record_checks("+
    "local_day TEXT PRIMARY KEY, checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const countDay=db.prepare(
    'SELECT COUNT(*) AS sales FROM orders WHERE '+validSales()+
    ' AND created_at>=? AND created_at<?');
  const highestBefore=db.prepare(
    "SELECT date(created_at,'+7 hours') AS day, COUNT(*) AS sales FROM orders WHERE "+
    validSales()+" AND created_at<? GROUP BY day ORDER BY sales DESC,day ASC LIMIT 1");
  const topPoint=db.prepare(
    "SELECT o.point_id,COALESCE(p.name,'Точка') AS point_name,"+
    "date(o.created_at,'+7 hours') AS day,COUNT(*) AS sales "+
    'FROM orders o JOIN points p ON p.id=o.point_id WHERE '+validSales('o')+
    ' AND o.created_at>=? AND o.created_at<? GROUP BY o.point_id,day '+
    'ORDER BY sales DESC,o.point_id LIMIT 1');
  const maxPointEver=db.prepare(
    "SELECT o.point_id,COALESCE(p.name,'Точка') AS point_name,"+
    "date(o.created_at,'+7 hours') AS day,COUNT(*) AS sales "+
    'FROM orders o JOIN points p ON p.id=o.point_id WHERE '+validSales('o')+
    ' AND o.created_at<? GROUP BY o.point_id,day '+
    'ORDER BY sales DESC,day ASC,o.point_id LIMIT 1');
  const maxCheck=db.prepare('SELECT MAX(total) AS amount FROM orders WHERE '+validSales());
  const seen=db.prepare('SELECT 1 FROM partner_club_daily_record_checks WHERE local_day=?');
  const mark=db.prepare('INSERT OR IGNORE INTO partner_club_daily_record_checks(local_day) VALUES(?)');
  const total=(from,to)=>Number(countDay.get(from,to).sales||0);
  function metrics(now=new Date()){
    const b=bounds(now);
    const best=highestBefore.get(b.todayStart);
    const point=maxPointEver.get(b.todayStart);
    const check=maxCheck.get();
    return {
      timezone:'Asia/Krasnoyarsk',
      definition:'Оплаченные заказы по дате создания; без тестовых, самозаказов и полных возвратов',
      max_check:check.amount==null?null:Number(check.amount),
      max_daily_sales:best?{day:best.day,sales:Number(best.sales)}:null,
      max_point_daily_sales:point?{
        day:point.day,sales:Number(point.sales),point_id:point.point_id,
        point_name:point.point_name,
      }:null,
      today_sales:total(b.todayStart,b.tomorrowStart),
      yesterday_sales:total(b.yesterdayStart,b.todayStart),
    };
  }
  function checkYesterday(now=new Date(),config={},queue=()=>false){
    if(!config.record_day||!config.enabled||!config.chat_id||!config.club_started_at)
      return false;
    const b=bounds(now);
    if(seen.get(b.yesterday))return false;
    // A club started today should not generate news from before activation.
    const activeSince=String(config.club_started_at).replace('T',' ').slice(0,19);
    let queued=false;
    if(activeSince<=b.yesterdayStart){
      const count=total(b.yesterdayStart,b.todayStart);
      const before=highestBefore.get(b.yesterdayStart);
      if(before&&count>Number(before.sales)){
        const top=topPoint.get(b.yesterdayStart,b.todayStart);
        queued=queue('record-day:'+b.yesterday+':'+count,'record_day',
          message(b.yesterday,count,Number(before.sales),top));
      }
    }
    mark.run(b.yesterday);
    return queued;
  }
  function validate(eventKey,now=new Date()){
    const m=String(eventKey||'').match(/^record-day:(\d{4}-\d{2}-\d{2}):([1-9]\d*)$/);
    if(!m)return false;
    const start=Date.parse(m[1]+'T00:00:00Z')-OFFSET_MS;
    if(!Number.isFinite(start)||toSql(start+DAY_MS)>toSql(now.getTime()))return false;
    const begin=toSql(start),end=toSql(start+DAY_MS);
    const current=total(begin,end);
    const previous=highestBefore.get(begin);
    const highestNow=highestBefore.get(bounds(now).todayStart);
    return current===Number(m[2])&&previous&&current>Number(previous.sales)&&
      Number(highestNow?.sales||0)<=current;
  }
  return {metrics,checkYesterday,validate};
}
module.exports={createDailySalesRecords,bounds,validSales,message};
