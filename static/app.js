'use strict';
const $ = s => document.querySelector(s);
const names = {delivery:'Доставка', return:'Возврат', product:'О товаре', other:'Другое'};
const statuses = {new:'Новое', review:'На проверке', approved:'Подтверждено'};
let tickets = [], selected = null, filter = 'all', mode = 'demo', busy = false;
const escapeHTML = s => String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time = s => new Date(s).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
function notice(text='', error=false){$('#notice').textContent=text;$('#notice').className='notice'+(error?' error':'');}
async function api(path, data){const r=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const j=await r.json();if(!r.ok)throw Error(j.error||'Не удалось выполнить запрос');return j;}
async function run(task){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await task();}catch(e){notice(e.message,true);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
async function refresh(){tickets=(await api('/api/tickets')).tickets;renderList();await renderDetail();}
function renderList(){
  $('#total').textContent=tickets.length;
  for(const status of ['new','review','approved'])$('#'+status+'-count').textContent=tickets.filter(t=>t.status===status).length;
  const query=$('#search').value.trim().toLowerCase();
  const shown=tickets.filter(t=>(filter==='all'||t.status===filter)&&(`${t.subject} ${t.message} ${t.id}`).toLowerCase().includes(query));
  $('#list-count').textContent=shown.length;
  $('#tickets').innerHTML=shown.map(t=>`<button class="ticket ${t.id===selected?'current':''}" data-id="${t.id}" aria-pressed="${t.id===selected}"><div class="ticket-top"><span>ЗАЯВКА #${String(t.id).padStart(4,'0')}</span><span>${escapeHTML(time(t.created_at))}</span></div><h3>${escapeHTML(t.subject)}</h3><p>${escapeHTML(t.message)}</p><div class="ticket-top"><span>${escapeHTML(names[t.category])}</span><span class="badge ${t.status}">${statuses[t.status]}</span></div></button>`).join('')||'<div class="empty small"><p>Обращений пока нет.<br>Создайте заявку или загрузите примеры.</p></div>';
  document.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>run(async()=>{if(!confirmDiscard())return;selected=Number(b.dataset.id);renderList();await renderDetail();}));
}
function confirmDiscard(){const t=tickets.find(t=>t.id===selected);if(t?.status==='review'&&$('#draft')&&($('#draft').value!==t.draft||$('#category').value!==t.category))return confirm('Перейти без сохранения изменений черновика?');return true;}
async function renderDetail(){
  const t=tickets.find(t=>t.id===selected);if(!t)return;
  const ready=t.status!=='new', approved=t.status==='approved';
  $('#detail').innerHTML=`<div class="detail-header"><span>ОБРАЩЕНИЕ #${String(t.id).padStart(4,'0')} · ${escapeHTML(time(t.created_at))}</span><span class="badge ${t.status}">${statuses[t.status]}</span></div><h2 class="title">${escapeHTML(t.subject)}</h2><div class="label">СООБЩЕНИЕ ПОКУПАТЕЛЯ</div><div class="message">${escapeHTML(t.message)}</div><div class="analysis-header"><h3>✧ Помощник поддержки</h3><span class="engine">${ready?(t.engine==='llm'?'Языковая модель':'Демо · правила'):(mode==='llm'?'LLM готова к обработке':'Демо · без обращения к ИИ')}</span></div>${ready?`<div class="category-row"><label for="category">Категория</label><select id="category" ${approved?'disabled':''}>${Object.entries(names).map(([key,name])=>`<option value="${key}" ${t.category===key?'selected':''}>${name}</option>`).join('')}</select></div><p class="reason">${escapeHTML(t.reason)}</p><label class="label" for="draft">${approved?'ПОДТВЕРЖДЁННЫЙ ОТВЕТ':'ЧЕРНОВИК ОТВЕТА'}</label><textarea id="draft" class="draft" ${approved?'readonly':''}>${escapeHTML(t.draft)}</textarea>${approved?'<p class="helper">✓ Проверено сотрудником. Внешняя отправка не выполнялась.</p>':'<div class="actions"><button class="primary" id="approve">✓ Подтвердить ответ</button><button class="secondary" id="save">Сохранить правки</button><button class="quiet" id="regenerate">Обработать заново</button></div><p class="helper">Проверьте факты и формулировки. Подтверждение сохраняет ответ в кабинете.</p>'}`:'<p class="reason">Определите тему обращения и подготовьте ответ для проверки сотрудником.</p><button class="primary" id="analyze">✧ Обработать заявку</button><p class="helper">'+(mode==='llm'?'Текст будет передан настроенному вами провайдеру модели.':'Демонстрационный режим использует правила и шаблоны, без языковой модели.')+'</p>'}<details class="events"><summary>История обработки</summary><ul id="events-list"></ul></details>`;
  for(const button of ['analyze','regenerate'])if($('#'+button))$('#'+button).onclick=()=>run(async()=>{if(button==='regenerate'&&!confirmDiscard())return;notice('Обрабатываем обращение…');await api(`/api/tickets/${t.id}/analyze`,{});await refresh();notice('Черновик готов. Проверьте его перед подтверждением.');});
  for(const action of ['save','approve'])if($('#'+action))$('#'+action).onclick=()=>run(async()=>{await api(`/api/tickets/${t.id}/${action==='save'?'draft':'approve'}`,{draft:$('#draft').value,category:$('#category').value});await refresh();notice(action==='save'?'Изменения сохранены.':'Ответ подтверждён и сохранён. Покупателю ничего не отправлено.');});
  const events=(await api(`/api/tickets/${t.id}/events`)).events;
  if(selected!==t.id)return;
  const labels={created:'Заявка создана',analyzed_demo:'Черновик подготовлен по правилам',analyzed_llm:'Черновик подготовлен моделью',edited:'Черновик отредактирован',approved:'Ответ подтверждён сотрудником'};
  $('#events-list').innerHTML=events.map(e=>`<li>${escapeHTML(time(e.created_at))} · ${escapeHTML(labels[e.action]||e.action)}</li>`).join('');
}
$('#search').oninput=renderList;
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('selected',x===b));renderList();});
$('#new').onclick=()=>$('#create-dialog').showModal();
$('#close-dialog').onclick=()=>$('#create-dialog').close();
$('#create-form').onsubmit=e=>{e.preventDefault();run(async()=>{const data=new FormData(e.target);const result=await api('/api/tickets',{subject:data.get('subject'),message:data.get('message')});selected=result.id;e.target.reset();$('#create-dialog').close();await refresh();notice('Заявка создана. Теперь можно подготовить черновик.');});};
$('#seed').onclick=()=>run(async()=>{if(!confirmDiscard())return;await api('/api/seed',{});tickets=(await api('/api/tickets')).tickets;if(tickets.length)selected=tickets[0].id;await refresh();notice('Демо-заявки доступны. Повторная загрузка не добавляет дубли.');});
run(async()=>{mode=(await api('/api/config')).mode;$('#mode').textContent=mode==='llm'?'● Режим языковой модели':'● Демо-режим · без ключа';await refresh();if(tickets.length){selected=tickets[0].id;renderList();await renderDetail();}});
