#!/usr/bin/env python3
"""Generate study-first PDFs from confirmed notes.

Only source image/title/path/remark/wrongReason are used. The machine-generated
`items` field is deliberately ignored. Added text is limited to reviewed,
low-risk study prompts; no answer, solution, formula or theorem is invented.
"""
from __future__ import annotations
import hashlib, html, json, re, tempfile
from pathlib import Path
from typing import Any
from PIL import Image as PI, ImageChops, ImageStat
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (CondPageBreak, Image, KeepTogether, PageBreak,
    Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle)

ROOT=Path(__file__).resolve().parents[1]; INDEX=ROOT/'data/index.json'; OUT=ROOT/'generated'
MISTAKE=OUT/'错题综合整理.pdf'; MEMORY=OUT/'背诵综合整理.pdf'; MANIFEST=OUT/'manifest.json'
PW,PH=A4; FONT='STSong-Light'; UW=PW-28*mm
pdfmetrics.registerFont(UnicodeCIDFont(FONT))
BODY=ParagraphStyle('body',fontName=FONT,fontSize=9.5,leading=14,textColor=colors.HexColor('#202A31'),wordWrap='CJK')
SMALL=ParagraphStyle('small',fontName=FONT,fontSize=8.2,leading=11.5,textColor=colors.HexColor('#65727A'),wordWrap='CJK')
TITLE=ParagraphStyle('title',fontName=FONT,fontSize=14.2,leading=19,textColor=colors.HexColor('#142C3B'),spaceAfter=2,wordWrap='CJK')
PATH=ParagraphStyle('path',fontName=FONT,fontSize=8.2,leading=11,textColor=colors.HexColor('#65727A'),wordWrap='CJK')
SECTION=ParagraphStyle('section',fontName=FONT,fontSize=16.5,leading=22,textColor=colors.white,wordWrap='CJK')
TOCH=ParagraphStyle('toch',fontName=FONT,fontSize=21,leading=28,textColor=colors.HexColor('#142C3B'))
TOCG=ParagraphStyle('tocg',fontName=FONT,fontSize=11.5,leading=17,textColor=colors.HexColor('#173B54'),spaceBefore=5)
TOCI=ParagraphStyle('toci',fontName=FONT,fontSize=9,leading=13,leftIndent=4*mm,textColor=colors.HexColor('#36454F'),wordWrap='CJK')

PROMPTS={
'inverse':'先写清原函数输入与反函数输入的对应关系，再代入后续关系。',
'piecewise':'先分别判断每一层表达式的自变量落在哪个区间，再选用对应分段。',
'definition':'先把目标极限与导数定义逐项对齐：基点、增量和分母。',
'taylor':'先确认展开中心与目标幂次，再比较对应系数；不要跳过适用条件。',
'higher':'检查导数阶数、符号、下标、阶乘和幂次是否同步变化。',
'sequence':'先区分连续变量的变化与整数项的比较；得到连续结论后还要检查相邻整数。',
'implicit':"每次对含 y 的项关于 x 求导时，检查是否需要乘 y'；再次求导时还要检查乘积项。",
'square':'平方可能丢失符号信息；比较平方前先核对两边的符号或取值范围。',
'limit':'先核对所用极限方法的适用条件，再进行等价替换、化简或求导。',
'generic':'先用一句话写出本题第一步所依据的定义、条件或判据，再开始计算。'}

def norm(v:Any)->str:return re.sub(r'\s+',' ',str(v or '').strip())
def esc(v:Any)->str:return html.escape(re.sub(r'[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]','',str(v or '').strip())).replace('\n','<br/>')
def sha(p:Path)->str:
 h=hashlib.sha256()
 with p.open('rb') as f:
  for c in iter(lambda:f.read(1<<20),b''):h.update(c)
 return h.hexdigest()
def npath(n):
 p=[norm(x) for x in n.get('knowledgePath') or [] if norm(x)]; s=norm(n.get('subject')) or '未分类'
 if not p or p[0]!=s:p.insert(0,s)
 return ' / '.join(p)

def load():
 d=json.loads(INDEX.read_text('utf-8')); notes=[]; errors=[]; ids=set(); paths=set()
 for raw in d.get('notes',[]):
  if not isinstance(raw,dict) or raw.get('organizationStatus')!='confirmed' or raw.get('kind') not in {'mistake','memory'}:continue
  i=norm(raw.get('id')); rel=norm(raw.get('imagePath'))
  if not i or i in ids:errors.append(f'invalid/duplicate id: {i}');continue
  ids.add(i)
  if not rel.startswith('data/assets/') or '..' in Path(rel).parts or rel in paths:errors.append(f'{i}: invalid/duplicate imagePath');continue
  paths.add(rel); p=ROOT/rel
  if not p.is_file() or sha(p)!=norm(raw.get('imageSha256')).lower():errors.append(f'{i}: missing or hash-mismatched image');continue
  try:
   with PI.open(p) as im:im.verify()
  except Exception as e:errors.append(f'{i}: unreadable image: {e}');continue
  n=dict(raw);n.pop('items',None);n['_image']=p;n['_path']=npath(n);notes.append(n)
 if errors:raise RuntimeError('Content-source review failed:\n'+'\n'.join(errors))
 if not any(n['kind']=='mistake' for n in notes) or not any(n['kind']=='memory' for n in notes):raise RuntimeError('Both mistake and memory records are required')
 return d,notes

def bg(im):
 im=im.convert('RGB');w,h=im.size;s=max(2,min(24,w//20,h//20)); vals=[]
 for b in [(0,0,s,s),(w-s,0,w,s),(0,h-s,s,h),(w-s,h-s,w,h)]:vals.append(tuple(int(x) for x in ImageStat.Stat(im.crop(b)).median[:3]))
 return tuple(sorted(v[k] for v in vals)[2] for k in range(3))
def prep(path:Path,tmp:Path,i:str):
 with PI.open(path) as src:
  src.load();im=src.convert('RGB');w,h=im.size;diff=ImageChops.difference(im,PI.new('RGB',im.size,bg(im))).convert('L');box=diff.point(lambda x:255 if x>22 else 0).getbbox()
  if box:
   l,t,r,b=box;pad=max(8,int(min(w,h)*.012));l=max(0,l-pad);t=max(0,t-pad);r=min(w,r+pad);b=min(h,b+pad)
   if l<=.16*w and t<=.16*h and w-r<=.16*w and h-b<=.16*h and (r-l)*(b-t)>=.72*w*h:im=im.crop((l,t,r,b))
  w,h=im.size
  if h/max(w,1)>2.15:
   mid=h//2;ov=max(12,int(h*.025));out=[]
   for j,box in enumerate([(0,0,w,min(h,mid+ov)),(0,max(0,mid-ov),w,h)]):
    p=tmp/f'{i}-{j}.png';im.crop(box).save(p);out.append(p)
   return out
  p=tmp/f'{i}.png';im.save(p);return [p]

def footer(c,d):c.saveState();c.setFont(FONT,8);c.setFillColor(colors.HexColor('#7D878E'));c.drawCentredString(PW/2,7.2*mm,str(d.page));c.restoreState()
def band(text):
 t=Table([[Paragraph(esc(text),SECTION)]],colWidths=[UW]);t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#173B54')),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)]));return t
def box(label,text,tone='blue'):
 pal={'blue':('#F2F6F8','#B7CAD4','#173B54'),'red':('#FAF0F0','#D7B0B0','#792E2E'),'amber':('#FBF6EA','#DCC58E','#75531C'),'green':('#EEF6F0','#B7CFBD','#315C3C')};bgc,bd,hd=pal[tone]
 ls=ParagraphStyle('l'+tone,fontName=FONT,fontSize=9,leading=12.5,textColor=colors.HexColor(hd),wordWrap='CJK')
 t=Table([[Paragraph(esc(label),ls),Paragraph(text,BODY)]],colWidths=[25*mm,UW-25*mm]);t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor(bgc)),('BOX',(0,0),(-1,-1),.6,colors.HexColor(bd)),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]));return t
def blank():
 t=Table([[''],[''],['']],colWidths=[UW],rowHeights=[7.3*mm]*3);t.setStyle(TableStyle([('BOX',(0,0),(-1,-1),.55,colors.HexColor('#D3DDE2')),('LINEBELOW',(0,0),(-1,-2),.3,colors.HexColor('#E4EAED'))]));return t
def imagepanel(paths,target):
 mh=(88 if target=='mistake' else 78)*mm
 if len(paths)==1:
  with PI.open(paths[0]) as im:w,h=im.size
  s=min((UW-4*mm)/w,mh/h);cell=Image(str(paths[0]),w*s,h*s);data=[[cell]];widths=[UW]
 else:
  cw=(UW-3*mm)/2;data=[[]];widths=[cw,cw]
  for p in paths:
   with PI.open(p) as im:w,h=im.size
   s=min((cw-3*mm)/w,mh/h);data[0].append(Image(str(p),w*s,h*s))
 t=Table(data,colWidths=widths);t.setStyle(TableStyle([('ALIGN',(0,0),(-1,-1),'CENTER'),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('BOX',(0,0),(-1,-1),.45,colors.HexColor('#D4DDE2')),('INNERGRID',(0,0),(-1,-1),.3,colors.HexColor('#E1E7EA')),('LEFTPADDING',(0,0),(-1,-1),2*mm),('RIGHTPADDING',(0,0),(-1,-1),2*mm),('TOPPADDING',(0,0),(-1,-1),1.5*mm),('BOTTOMPADDING',(0,0),(-1,-1),1.5*mm)]));return t
def prompt(n):
 text=' '.join(norm(n.get(k)) for k in ('title','remark','wrongReason','questionType')).lower()
 for key,words in [('inverse',['反函数']),('piecewise',['分段','范围','区间判断']),('definition',['导数定义','定义式']),('taylor',['泰勒','展开唯一']),('implicit',['隐函数']),('square',['平方','同号']),('sequence',['数列','n^(1/n)','最大项']),('higher',['高阶导数','n阶导数','n 阶导数']),('limit',['极限','洛必达','等价无穷小'])]:
  if any(w in text for w in words):return key,PROMPTS[key]
 return 'generic',PROMPTS['generic']
def toc(title,notes):
 g={}
 for n in notes:g.setdefault(n['_path'],[]).append(norm(n.get('title')) or '未命名条目')
 s=[Paragraph(esc(title),TOCH),Spacer(1,2*mm)]
 for p,ts in sorted(g.items()):
  s.append(Paragraph(esc(p),TOCG));s.extend(Paragraph('• '+esc(x),TOCI) for x in ts)
 return s+[PageBreak()]

def build_mistakes(notes,imgs):
 story=toc('错题集目录',notes);prov=[];groups={}
 for n in notes:groups.setdefault(n['_path'],[]).append(n)
 first=True
 for path,ns in sorted(groups.items()):
  if not first:story.append(PageBreak())
  first=False;story += [band('错题集 / '+path),Spacer(1,4*mm)]
  for j,n in enumerate(ns):
   if j:story.append(PageBreak())
   i=norm(n['id']);story += [Paragraph(esc(n.get('title') or '未命名错题'),TITLE),Paragraph(esc(path),PATH),Spacer(1,2.5*mm),imagepanel(imgs[i],'mistake'),Spacer(1,2.6*mm)]
   r,w=norm(n.get('remark')),norm(n.get('wrongReason'))
   if r:story += [box('原始备注',esc(r),'blue'),Spacer(1,2*mm)]
   if w:story += [box('已记录错因',esc(w),'red'),Spacer(1,2*mm)]
   key,p=prompt(n);story += [box('关键转折',esc(p),'amber'),Spacer(1,2*mm)]
   recall='遮住原图中的订正，回答：本题最先要检查什么？为什么？';check='条件与对象 → 适用规则 → 关键计算 → 回代、边界或结果检查。'
   t=Table([[Paragraph('主动回忆',SMALL),Paragraph('二刷检查',SMALL)],[Paragraph(esc(recall),BODY),Paragraph(esc(check),BODY)]],colWidths=[UW/2,UW/2]);t.setStyle(TableStyle([('BOX',(0,0),(-1,-1),.55,colors.HexColor('#C8D4DA')),('INNERGRID',(0,0),(-1,-1),.35,colors.HexColor('#DDE5E9')),('BACKGROUND',(0,0),(-1,0),colors.HexColor('#F2F6F8')),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]));story += [t,Spacer(1,2.5*mm),Paragraph('补充 / 二刷记录',SMALL),Spacer(1,.8*mm),blank()]
   prov += [{'noteId':i,'field':'keyTurningPoint','rule':key,'text':p},{'noteId':i,'field':'activeRecall','text':recall},{'noteId':i,'field':'secondPassChecklist','text':check}]
 SimpleDocTemplate(str(MISTAKE),pagesize=A4,leftMargin=14*mm,rightMargin=14*mm,topMargin=12*mm,bottomMargin=14*mm,title='错题综合整理').build(story,onFirstPage=footer,onLaterPages=footer);return prov

def build_memory(notes,imgs):
 story=toc('背诵集目录',notes);prov=[];groups={};recall='遮住原图，完整复述或默写核心内容；再逐项核对条件、符号、下标和例外。'
 for n in notes:groups.setdefault(n['_path'],[]).append(n)
 first=True
 for path,ns in sorted(groups.items()):
  if not first:story.append(PageBreak())
  first=False;story += [band('背诵集 / '+path),Spacer(1,4*mm)]
  for j,n in enumerate(ns):
   if j:story += [Spacer(1,3.5*mm),CondPageBreak(112*mm)]
   i=norm(n['id']);parts=[Paragraph(esc(n.get('title') or '未命名背诵内容'),TITLE),Paragraph(esc(path),PATH),Spacer(1,2*mm),imagepanel(imgs[i],'memory')]
   r=norm(n.get('remark'))
   if r:parts += [Spacer(1,1.8*mm),box('原始备注',esc(r),'blue')]
   parts += [Spacer(1,1.8*mm),box('主动回忆',esc(recall),'green')];story.append(KeepTogether(parts));prov.append({'noteId':i,'field':'activeRecall','text':recall})
 SimpleDocTemplate(str(MEMORY),pagesize=A4,leftMargin=14*mm,rightMargin=14*mm,topMargin=12*mm,bottomMargin=14*mm,title='背诵综合整理').build(story,onFirstPage=footer,onLaterPages=footer);return prov

def main():
 OUT.mkdir(exist_ok=True);d,notes=load();mist=[n for n in notes if n['kind']=='mistake'];mem=[n for n in notes if n['kind']=='memory']
 with tempfile.TemporaryDirectory(prefix='review-pdf-') as td:
  tmp=Path(td);imgs={norm(n['id']):prep(n['_image'],tmp,norm(n['id'])) for n in notes};prov=build_mistakes(mist,imgs)+build_memory(mem,imgs)
 payload={'schemaVersion':2,'generationPolicy':'confirmed-original-images-only-no-invented-content','contentVersion':'study-first-v2','sourceIndexSha256':sha(INDEX),'sourceRevision':d.get('sourceRevision'),'counts':{'mistake':len(mist),'memory':len(mem)},'contentRules':{'sourceFieldsUsed':['title','subject','knowledgePath','remark','wrongReason','imagePath'],'ignoredFields':['items'],'allowedGenerated':['key-first-step reminder','active-recall question','second-pass checklist'],'forbiddenGenerated':['new answer','new solution','new formula','new theorem','exam prediction','unsupported extension'],'uncertainContentPolicy':'omit rather than infer'},'provenance':prov,'files':[{'path':'generated/错题综合整理.pdf','bytes':MISTAKE.stat().st_size,'sha256':sha(MISTAKE)},{'path':'generated/背诵综合整理.pdf','bytes':MEMORY.stat().st_size,'sha256':sha(MEMORY)}]}
 MANIFEST.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n','utf-8');print(f'Generated {len(mist)} mistakes and {len(mem)} memory records')
if __name__=='__main__':main()
