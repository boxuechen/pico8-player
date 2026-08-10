pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 local x0,y0=camera(-7,9)
 local x1,y1=camera()
 local x2,y2=camera(5,-6)
 local x3,y3=camera(2,3)
 local x4,y4=camera()
 poke(0x5000,
  x0==0 and y0==0 and 1 or 0,
  x1==-7 and y1==9 and 1 or 0,
  x2==0 and y2==0 and 1 or 0,
  x3==5 and y3==-6 and 1 or 0,
  x4==2 and y4==3 and 1 or 0,
  peek2(0x5f28)==0 and peek2(0x5f2a)==0 and 1 or 0)
end
function _update() end
function _draw() end
