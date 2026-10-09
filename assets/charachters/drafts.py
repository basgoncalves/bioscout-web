import cairosvg
from PIL import Image, ImageDraw, ImageFont
def poly(pts): return '<polygon points="%s"/>'%" ".join(f"{x:.1f},{y:.1f}" for x,y in pts)
def rect(x,y,w,h,r=1.5): return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}"/>'
def mir(cx,pts,f):  # pts as (dx_left, y); returns both sides
    return f([(cx-dx,y) for dx,y in pts])+f([(cx+dx,y) for dx,y in pts])
def C(cx,pts): return [(cx+dx,y) for dx,y in pts]

def faceted(cx,back):
    M=lambda pts:mir(cx,pts,poly); o=[]
    o.append((None,poly(C(cx,[(-27,43),(27,43),(21,90),(18,127),(-18,127),(-21,90)]))))
    o.append((None,poly(C(cx,[(-12,7),(12,7),(13.5,21),(6,33),(-6,33),(-13.5,21)]))))
    o.append(("neck",poly(C(cx,[(-6,31),(6,31),(8,43),(-8,43)]))))
    o.append(("shoulders",M([(14,43),(32,45),(36,58),(23,60)])))
    o.append(("triceps" if back else "biceps",M([(24,62),(36,61),(34,95),(27,95)])))
    o.append((None,M([(27,97),(35,97),(38,127),(32,127)])))
    o.append((None,M([(31,129),(40,129),(41,139),(33,141)])))
    if not back:
        o.append(("chest",M([(1.5,45),(22,45),(20,63),(1.5,69)])))
        o.append(("core",poly(C(cx,[(-12,72),(12,72),(13,92),(11,112),(-11,112),(-13,92)]))))
        o.append(("hip",poly(C(cx,[(-17,114),(17,114),(19,128),(0,133),(-19,128)]))))
        o.append(("quads",M([(3,134),(21,130),(17,186),(6,186)])))
        o.append(("knee",M([(11.5,188),(17,193),(11.5,198),(6,193)])))
        o.append(("shin",M([(6,201),(17,201),(15,240),(9,240)])))
    else:
        o.append(("back",poly(C(cx,[(-15,41),(15,41),(0,66)]))+M([(20,57),(2,68),(2,103),(14,92)])))
        o.append(("core",poly(C(cx,[(-11,101),(11,101),(12,116),(-12,116)]))))
        o.append(("glutes",M([(1,118),(20,117),(22,137),(3,140)])))
        o.append(("hamstrings",M([(3,143),(21,140),(17,188),(6,188)])))
        o.append(("knee",M([(11.5,189),(17,194),(11.5,199),(6,194)])))
        o.append(("calves",M([(5,200),(18,200),(16,221),(11,241),(7,221)])))
    o.append(("ankle",M([(6,243),(17,243),(20,251),(5,251)])))
    return o

def block(cx,back):
    o=[]; R=lambda dx,y,w,h,r=1.5: rect(cx-dx-w,y,w,h,r)+rect(cx+dx,y,w,h,r)
    o.append((None,rect(cx-24,43,48,84,3)))
    o.append((None,rect(cx-12,6,24,26,4)))
    o.append(("neck",rect(cx-6,33,12,9,1)))
    o.append(("shoulders",R(14,43,20,14)))
    o.append(("triceps" if back else "biceps",R(22,59,12,35)))
    o.append((None,R(24,96,10,32)))
    o.append((None,R(25,130,9,10)))
    if not back:
        o.append(("chest",R(1,45,20,20)))
        o.append(("core",rect(cx-12,67,11,14)+rect(cx+1,67,11,14)+rect(cx-12,83,11,14)+rect(cx+1,83,11,14)+rect(cx-12,99,11,13)+rect(cx+1,99,11,13)))
        o.append(("hip",rect(cx-19,114,38,14,1.5)))
        o.append(("quads",R(2,130,17,56)))
        o.append(("knee",R(4,188,13,9)))
        o.append(("shin",R(5,199,11,41)))
    else:
        o.append(("back",rect(cx-14,44,28,14)+R(2,60,19,40)))
        o.append(("core",rect(cx-12,102,24,14)))
        o.append(("glutes",R(1,118,19,22)))
        o.append(("hamstrings",R(2,142,17,44)))
        o.append(("knee",R(4,188,13,9)))
        o.append(("calves",R(4,199,13,41)))
    o.append(("ankle",R(4,243,15,7)))
    return o

def armor(cx,back):
    M=lambda pts:mir(cx,pts,poly); o=[]
    o.append((None,poly(C(cx,[(-28,44),(28,44),(20,92),(18,127),(-18,127),(-20,92)]))))
    o.append((None,poly(C(cx,[(-7,6),(7,6),(13,12),(13,24),(7,32),(-7,32),(-13,24),(-13,12)]))))
    o.append(("neck",poly(C(cx,[(-7,32),(7,32),(5,42),(-5,42)]))))
    o.append(("shoulders",M([(15,42),(27,41),(37,48),(35,58),(25,61),(17,54)])))
    o.append(("triceps" if back else "biceps",M([(25,63),(35,62),(37,78),(33,95),(27,95),(24,78)])))
    o.append((None,M([(27,97),(34,97),(38,112),(37,127),(32,127),(29,112)])))
    o.append((None,M([(32,129),(39,129),(41,135),(37,141),(33,141)])))
    if not back:
        o.append(("chest",M([(1.5,45),(23,45),(21,60),(12,68),(1.5,66)])))
        o.append(("core",poly(C(cx,[(-12,70),(0,75),(12,70),(12,84),(0,89),(-12,84)]))+
                         poly(C(cx,[(-12,87),(0,92),(12,87),(11,100),(0,105),(-11,100)]))+
                         poly(C(cx,[(-11,103),(0,108),(11,103),(10,113),(0,117),(-10,113)]))))
        o.append(("hip",poly(C(cx,[(-18,116),(-8,120),(0,119),(8,120),(18,116),(19,128),(0,136),(-19,128)]))))
        o.append(("quads",M([(4,138),(14,129),(22,140),(18,182),(11,188),(6,180)])))
        o.append(("knee",M([(11,186),(17,193),(11,200),(5,193)])))
        o.append(("shin",M([(6,203),(11,200),(16,203),(15,232),(11,241),(8,232)])))
    else:
        o.append(("back",poly(C(cx,[(-16,41),(16,41),(0,64)]))+M([(21,56),(3,67),(2,104),(9,100),(16,84)])))
        o.append(("core",poly(C(cx,[(-12,102),(0,106),(12,102),(12,114),(0,118),(-12,114)]))))
        o.append(("glutes",M([(2,121),(12,117),(22,123),(22,135),(13,141),(3,137)])))
        o.append(("hamstrings",M([(4,143),(13,141),(21,146),(18,182),(11,188),(6,182)])))
        o.append(("knee",M([(11,187),(17,194),(11,201),(5,194)])))
        o.append(("calves",M([(6,206),(11,200),(18,207),(16,224),(11,241),(7,224)])))
    o.append(("ankle",M([(6,243),(17,243),(20,250),(12,252),(5,250)])))
    return o

TRAINED={"quads","glutes","core"}; SEL="hamstrings"
def svg(fn,dark=True):
    base,part,done,sel,bg=("#2b3448","#4a5674","#1fb59a","#f08a3c","#141a26") if dark else ("#c9d0dc","#9aa6bb","#1fb59a","#f08a3c","#ffffff")
    def draw(cx,back):
        out=[]
        for reg,shape in fn(cx,back):
            col=base if reg is None else sel if reg==SEL else done if reg in TRAINED else part
            out.append(f'<g fill="{col}" stroke="{bg}" stroke-width="1.2" stroke-linejoin="miter">{shape}</g>')
        return "".join(out)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 262" width="520" height="524"><rect width="260" height="262" fill="{bg}"/>{draw(60,False)}{draw(200,True)}</svg>'
designs=[("A_faceted","A · Faceted",faceted,"Tapered polygons like the promo-video characters; angular head with pointed chin, diamond knees."),
         ("B_block","B · Block",block,"Straight rectangles with clean gaps; six-pack grid; most 'pixel/robot' look, very readable at small size."),
         ("C_armor","C · Armor plates",armor,"Low-poly hex plates: chevron abs, hex pauldrons, octagon head; the most 'anime action' of the three.")]
import os
fT=ImageFont.truetype("/usr/share/fonts/opentype/inter/Inter-Bold.otf",30); fS=ImageFont.truetype("/usr/share/fonts/opentype/inter/Inter-Medium.otf",17)
sheet=Image.new("RGB",(3*560+40,1240),(10,14,24)); d=ImageDraw.Draw(sheet)
for i,(key,title,fn,desc) in enumerate(designs):
    for mode,y in (("dark",80),("light",640)):
        s=svg(fn,mode=="dark"); open(f"draft_{key}_{mode}.svg","w").write(s)
        cairosvg.svg2png(bytestring=s.encode(),write_to=f"draft_{key}_{mode}.png",output_width=520)
        im=Image.open(f"draft_{key}_{mode}.png").convert("RGB"); sheet.paste(im,(40+i*560,y))
    d.text((40+i*560,20),title,font=fT,fill=(240,244,250))
    import textwrap
    for j,l in enumerate(textwrap.wrap(desc,52)): d.text((40+i*560,1170+j*22),l,font=fS,fill=(150,160,180))
sheet.save("drafts_overview.png")
