pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _update()
 poke(0x5240,peek(0x5240)+1)
end

function _draw()
 cls(1)
 pset(peek(0x5240)%128,0,7)
end
