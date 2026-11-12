pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
frame=0

function _update()
 frame+=1
 local n=frame==1 and 22428 or frame==2 and 22429 or 22430
 local x=0
 for i=1,22000 do x+=i end
 for i=1,n do x+=i end
 poke4(0x5100,x)
end

function _draw()
 local a=0x5000+(frame-1)*12
 poke4(a,stat(1))
 poke4(a+4,stat(7))
 poke4(a+8,time())
end
