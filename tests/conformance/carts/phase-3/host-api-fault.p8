pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 poke(0x3200,24,14)
 sfx(0)
end

function _update60()
 cstore(0x4300,0,1)
end

function _draw()
 cls(8)
end
