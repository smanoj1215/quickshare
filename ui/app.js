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
function showResult(html){result.innerHTML=html;result.hidden=false;result.scrollIntoView({behavior:'smooth',block:'nearest'})}
fileInput.addEventListener('change',()=>{const f=fileInput.files[0];$('file-label').innerHTML=f?`${escapeHtml(f.name)} <span>· ${formatSize(f.size)}</span>`:'Choose a file <span>or drop it here</span>'});
for(const ev of ['dragenter','dragover'])dropzone.addEventListener(ev,e=>{e.preventDefault();dropzone.classList.add('drag')});
for(const ev of ['dragleave','drop'])dropzone.addEventListener(ev,e=>{e.preventDefault();dropzone.classList.remove('drag')});
dropzone.addEventListener('drop',e=>{if(e.dataTransfer.files.length){fileInput.files=e.dataTransfer.files;fileInput.dispatchEvent(new Event('change'))}});
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
$('upload-form').addEventListener('submit',async e=>{
  e.preventDefault(); const file=fileInput.files[0]; if(!file)return;
  if(file.size>config.max_upload_size_mb*1024*1024){setStatus('upload-status',`That file is over the ${config.max_upload_size_mb} MB limit.`,'error');return}
  const btn=$('upload-button');btn.disabled=true;btn.querySelector('span').textContent='Uploading…';setStatus('upload-status','Your file is on its way.');result.hidden=true;
  try{
    const body=new FormData();body.append('file',file);body.append('expiry_minutes',$('expiry').value);
    const res=await fetch('/api/shares',{method:'POST',body});const data=await res.json();if(!res.ok)throw new Error(data.detail||'Upload failed. Please try again.');
    setStatus('upload-status','Your share link is ready.','success');
    showResult(`<div class="result-main"><div class="result-title">${escapeHtml(data.filename)}</div><div class="result-sub">Code ${escapeHtml(data.code)} · Expires ${new Date(data.expires_at).toLocaleString()}</div></div><div class="result-actions"><button class="small-button" id="copy-code">Copy code</button><button class="small-button" id="copy-link">Copy link</button><a class="small-button primary" href="${escapeHtml(data.url)}">Open share</a></div>`);
    $('copy-code').onclick=()=>copy(data.code,$('copy-code'),'Code copied');$('copy-link').onclick=()=>copy(data.url,$('copy-link'),'Link copied');
  }catch(err){setStatus('upload-status',err.message,'error')}finally{btn.disabled=false;btn.querySelector('span').textContent='Make a share link'}
});
async function copy(text,button,label){try{await navigator.clipboard.writeText(text);button.textContent=label;setTimeout(()=>button.textContent=label.includes('Code')?'Copy code':'Copy link',1400)}catch{setStatus('upload-status','Copy is unavailable in this browser. Select and copy the share details.','error')}}
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
