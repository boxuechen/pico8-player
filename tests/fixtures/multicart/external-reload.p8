pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 reload(0x4300,0,16,"data-cart.p8")
 for i=0,15 do
  poke(0x5000+i,peek(0x4300+i))
 end
end

function _draw()
 cls(3)
 for i=0,15 do
  pset(i,peek(0x5000+i)%128,7)
 end
end
