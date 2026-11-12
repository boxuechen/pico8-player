pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function seed_audio()
 for i=0,31 do
  poke(0x3200+i*2,24+i%12,14)
 end
 poke(0x3241,8)
 poke(0x3242,0)
 poke(0x3243,16)
end

function _init()
 seed_audio()
 cartdata("phase4f")
end

function _update()
 local x=0
 for i=1,25000 do x+=i end
 for i=1,25000 do x+=i end
 if btnp(4) then
  dset(0,0x4f)
  sfx(0,0,0,8)
 end
 poke4(0x5100,x)
end

function _draw()
 cls(1)
 pset(4,4,7)
 poke(0x5000,btn(4) and 1 or 0)
 poke(0x5001,btnp(4) and 1 or 0)
 poke4(0x5004,time())
 poke4(0x5008,stat(1))
 poke4(0x500c,stat(7))
end
