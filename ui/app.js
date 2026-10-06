const $ = (id) => document.getElementById(id);
const fileInput = $('file-input'), dropzone = $('dropzone'), result = $('result');
let config = {max_upload_size_mb:100, default_expiry_minutes:30, expiry_options_minutes:[5,10,30,60]};

async function loadConfig(){
  try { const r=await fetch('/api/config'); if(r.ok) config=await r.json(); } catch {}
  $('size-hint').textContent=`Up to ${config.max_upload_size_mb} MB · Private by default`;
  const select=$('expiry');
  [...select.options].forEach(o=>o.disabled=!config.expiry_options_minutes.includes(Number(o.value)));
  select.value=String(config.default_expiry_minutes);
}
function formatSize(n){return n<1024*1024?`${(n/1024).toFixed(0)} KB`:`${(n/1024/1024).toFixed(1)} MB`}
function setStatus(id,message,type=''){const el=$(id);el.textContent=message;el.className=`status ${type}`.trim()}
function showResult(html,batch=false){result.classList.toggle('batch-result',batch);result.innerHTML=html;result.hidden=false;result.scrollIntoView({behavior:'smooth',block:'nearest'})}
fileInput.addEventListener('change',()=>{
  const files=[...fileInput.files];
  $('file-label').innerHTML=files.length===0?'Choose files <span>or drop them here</span>':files.length===1?`${escapeHtml(files[0].name)} <span>· ${formatSize(files[0].size)}</span>`:`${files.length} files selected <span>· ${formatSize(files.reduce((n,f)=>n+f.size,0))} total</span>`;
});
for(const ev of ['dragenter','dragover'])dropzone.addEventListener(ev,e=>{e.preventDefault();dropzone.classList.add('drag')});
for(const ev of ['dragleave','drop'])dropzone.addEventListener(ev,e=>{e.preventDefault();dropzone.classList.remove('drag')});
dropzone.addEventListener('drop',e=>{if(e.dataTransfer.files.length){fileInput.files=e.dataTransfer.files;fileInput.dispatchEvent(new Event('change'))}});
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function shareCard(data){
  return `<article class="share-item"><div class="result-main"><div class="result-title">${escapeHtml(data.filename)}</div><div class="result-sub">Code ${escapeHtml(data.code)} · Expires ${new Date(data.expires_at).toLocaleString()}</div></div><div class="result-actions"><button class="small-button" data-copy="${escapeHtml(data.code)}" data-label="Copy code">Copy code</button><button class="small-button" data-copy="${escapeHtml(data.url)}" data-label="Copy link">Copy link</button><a class="small-button primary" href="${escapeHtml(data.url)}">Open share</a></div><input class="copy-fallback" aria-label="Select to copy share text" readonly value="${escapeHtml(data.url)}" hidden></article>`;
}
$('upload-form').addEventListener('submit',async e=>{
  e.preventDefault(); const files=[...fileInput.files]; if(!files.length)return;
  const btn=$('upload-button');btn.disabled=true;btn.querySelector('span').textContent='Uploading…';result.hidden=true;
  const shares=[],errors=[];
  for(let i=0;i<files.length;i++){
    const file=files[i];
    if(file.size>config.max_upload_size_mb*1024*1024){errors.push(`${file.name}: over the ${config.max_upload_size_mb} MB limit`);continue}
    setStatus('upload-status',`Uploading ${i+1} of ${files.length}: ${file.name}`);
    try{
      const body=new FormData();body.append('file',file);body.append('expiry_minutes',$('expiry').value);
      const res=await fetch('/api/shares',{method:'POST',body});const data=await res.json();if(!res.ok)throw new Error(data.detail||'Upload failed');shares.push(data);
    }catch(err){errors.push(`${file.name}: ${err.message}`)}
  }
  if(shares.length){
    showResult(`<div class="batch-heading">${shares.length} ${shares.length===1?'share is':'shares are'} ready</div>${shares.map(shareCard).join('')}${errors.length?`<div class="batch-errors">${errors.map(escapeHtml).join('<br>')}</div>`:''}`,true);
    result.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',()=>copy(button.dataset.copy,button)));
  }
  setStatus('upload-status',errors.length?`${shares.length} uploaded · ${errors.length} could not be shared.`:shares.length===1?'Your share link is ready.':`All ${shares.length} share links are ready.`,errors.length?'error':'success');
  btn.disabled=false;btn.querySelector('span').textContent='Make a share link';
});
async function copy(text,button){
  try{await navigator.clipboard.writeText(text);button.textContent='Copied';setTimeout(()=>button.textContent=button.dataset.label||'Copy',1400);return}catch{}
  const area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.position='fixed';area.style.left='-9999px';document.body.appendChild(area);area.select();
  let copied=false;try{copied=document.execCommand('copy')}catch{}area.remove();
  if(copied){button.textContent='Copied';setTimeout(()=>button.textContent=button.dataset.label||'Copy',1400);return}
  const fallback=button.closest('.share-item').querySelector('.copy-fallback');fallback.value=text;fallback.hidden=false;fallback.focus();fallback.select();setStatus('upload-status','Clipboard access is blocked here. The text is selected; copy it with Ctrl+C or ⌘C.','error');
}
async function findShare(code){
  code=code.trim().toUpperCase();$('code-input').value=code;setStatus('receive-status','Looking for your file…');result.hidden=true;
  try{const res=await fetch(`/api/shares/${encodeURIComponent(code)}`);const data=await res.json();if(!res.ok)throw new Error(data.detail||'Could not find this share.');
    setStatus('receive-status','Your file is ready.','success');showResult(`<div class="result-main"><div class="result-title">${escapeHtml(data.filename)}</div><div class="result-sub">${formatSize(data.size)} · Available until ${new Date(data.expires_at).toLocaleString()}</div></div><div class="result-actions"><a class="small-button primary" href="${escapeHtml(data.download_url)}">Download file ↓</a></div>`);
  }catch(err){setStatus('receive-status',err.message,'error')}
}
$('receive-form').addEventListener('submit',e=>{e.preventDefault();findShare($('code-input').value)});
$('code-input').addEventListener('input',e=>{e.target.value=e.target.value.replace(/[^a-z0-9]/gi,'').slice(0,10).toUpperCase()});
const params=new URLSearchParams(location.search);if(params.has('code'))findShare(params.get('code'));
loadConfig();
