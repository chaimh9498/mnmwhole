// Public M&M catalog. Its source is products.json until the live inventory backend is deployed.
// No passwords or customer secrets are stored in this frontend.
(()=>{'use strict';
const $=id=>document.getElementById(id);
const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
let items=[],cart={};
try{const c=JSON.parse(localStorage.getItem('mm_public_cart')||'{}');if(c&&typeof c==='object'&&!Array.isArray(c))cart=c;}catch{}
$('year').textContent=new Date().getFullYear();
function save(){try{localStorage.setItem('mm_public_cart',JSON.stringify(cart))}catch{}}
function openCart(v){$('shade').hidden=!v;$('drawer').hidden=!v;document.body.style.overflow=v?'hidden':''}
$('bagToggle').addEventListener('click',()=>openCart(true));
$('bagClose').addEventListener('click',()=>openCart(false));
$('shade').addEventListener('click',()=>openCart(false));
document.addEventListener('keydown',e=>{if(e.key==='Escape')openCart(false)});
function imageURL(s){if(typeof s!=='string')return null;s=s.trim();return s.startsWith('https://')||/^\.\/[a-z0-9_./-]+$/i.test(s)?s:null}
function renderCart(){const box=$('cartLines');box.replaceChildren();let count=0,total=0;
for(const [id,qty] of Object.entries(cart)){const p=items.find(i=>i.id===id);if(!p||!Number.isInteger(qty)||qty<1){delete cart[id];continue;}count+=qty;total+=p.priceCents*qty;
const row=document.createElement('div');row.className='line';const text=document.createElement('div');const name=document.createElement('strong');name.textContent=p.name;const detail=document.createElement('small');detail.textContent=qty+' × '+money(p.priceCents);text.append(name,detail);const remove=document.createElement('button');remove.textContent='Remove';remove.onclick=()=>{delete cart[id];renderCart()};row.append(text,remove);box.append(row);}
if(!count){const p=document.createElement('p');p.textContent='Your cart is empty.';box.append(p)}$('cartCount').textContent=String(count);$('cartTotal').textContent=money(total);save()}
function render(){const q=$('search').value.trim().toLowerCase(),cat=$('category').value;
const filtered=items.filter(p=>(!cat||p.category===cat)&&(!q||[p.name,p.category,p.description,p.sku].some(s=>String(s||'').toLowerCase().includes(q))));$('count').textContent=filtered.length+' of '+items.length+' public listings';$('products').replaceChildren();
for(const p of filtered){const article=document.createElement('article');article.className='product';const photo=document.createElement('div');photo.className='product-photo';const uri=imageURL(p.image);if(uri){const img=document.createElement('img');img.src=uri;img.alt=p.name;img.loading='lazy';img.onerror=()=>{img.remove();photo.textContent='M&M'};photo.append(img)}else photo.textContent='M&M';
const body=document.createElement('div');body.className='product-body';const tag=document.createElement('span');tag.className='tag';tag.textContent=p.category||'Wholesale';const name=document.createElement('h3');name.textContent=p.name;const d=document.createElement('p');d.textContent=p.description||'';const ft=document.createElement('div');ft.className='product-footer';const price=document.createElement('strong');price.className='price';price.textContent=money(p.priceCents);const b=document.createElement('button');b.className='add';b.textContent=p.stock>0?'Add to cart':'Sold out';b.disabled=p.stock<=0;b.addEventListener('click',()=>{cart[p.id]=Math.min(p.stock,(cart[p.id]||0)+1);renderCart();openCart(true)});ft.append(price,b);body.append(tag,name,d,ft);article.append(photo,body);$('products').append(article)}$('empty').hidden=filtered.length!==0;$('emptyTitle').textContent=items.length?'No matches found':'Inventory coming soon';$('emptyDescription').textContent=items.length?'Try another search or category.':'Our catalog is public. Real products will appear here as they are added. No customer access code is needed.';renderCart()}
$('search').addEventListener('input',render);$('category').addEventListener('change',render);
fetch('./products.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('No catalog file');return r.json()}).then(data=>{if(!Array.isArray(data))throw Error('Bad catalog');items=data.filter(p=>p&&typeof p.id==='string'&&typeof p.name==='string'&&Number.isSafeInteger(p.priceCents)&&p.priceCents>=0&&Number.isSafeInteger(p.stock)&&p.stock>=0&&p.active!==false&&p.isDemo!==true);for(const cat of [...new Set(items.map(p=>p.category).filter(Boolean))].sort()){const opt=document.createElement('option');opt.textContent=cat;opt.value=cat;$('category').append(opt)}render()}).catch(()=>{$('count').textContent='Unable to load product listings — try again later.';renderCart();$('empty').hidden=false});
})();