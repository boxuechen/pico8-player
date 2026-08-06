pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 for i=0,15 do
  poke(0x4300+i,0x80+i)
 end
 cstore(0,0x4300,16,"data-cart.p8")
 memset(0x4300,0,16)
 reload(0x4300,0,16,"data-cart.p8")
 for i=0,15 do
  poke(0x5000+i,peek(0x4300+i))
 end
end

function _draw()
 cls(4)
 for i=0,15 do
  pset(i,peek(0x5000+i)%128,10)
 end
end
