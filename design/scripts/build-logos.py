from pathlib import Path
import base64
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
p=Path('design/brand/logo'); f=instantiateVariableFont(TTFont('design/brand/fonts/Nunito-Variable.ttf'),{'wght':900}); glyphs=f.getGlyphSet(); cmap=f.getBestCmap(); x=0; paths=[]
for c in 'jelly':
 g=glyphs[cmap[ord(c)]]; pen=SVGPathPen(glyphs);g.draw(pen);paths.append(f'<path transform="translate({x} 0)" d="{pen.getCommands()}"/>');x+=g.width-25
word=''.join(paths); data='data:image/png;base64,'+base64.b64encode((p/'jelly-mark.png').read_bytes()).decode()
def svg(name,w,h,body):
 (p/name).write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img" aria-label="jelly">{body}</svg>')
for name,color,bg in [('horizontal','#14243A',''),('inverse','#F0F5FC','<rect width="460" height="180" rx="24" fill="#101D2E"/>')]:
 svg('jelly-'+name+'.svg',460,180,bg+f'<image href="{data}" x="12" y="12" width="150" height="150"/><g fill="{color}" transform="translate(180 126) scale(.16 -.16)">{word}</g>')
svg('jelly-wordmark.svg',x+100,1100,f'<g fill="#14243A" transform="translate(50 820) scale(1 -1)">{word}</g>')
svg('jelly-stacked.svg',320,390,f'<image href="{data}" x="25" y="0" width="270" height="270"/><g fill="#14243A" transform="translate(69 335) scale(.105 -.105)">{word}</g>')
svg('jelly-app-icon.svg',512,512,f'<rect width="512" height="512" rx="112" fill="#E4F0FF"/><image href="{data}" x="12" y="12" width="488" height="488"/>')
svg('jelly-favicon.svg',64,64,f'<rect width="64" height="64" rx="16" fill="#E4F0FF"/><image href="{data}" x="0" y="0" width="64" height="64"/>')
print('Created six logo SVG wrappers; character remains embedded raster, lettering outlined.')
