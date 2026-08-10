pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 poke(0x5000,0x2a)
 cstore(0x10,0x5000,1,"phase9-data.p8")
 poke(0x5001,0)
 reload(0x5001,0x10,1,"phase9-data.p8")
 poke(0x5002,peek(0x5001)==0x2a and 1 or 0)
end
function _update() end
function _draw()
 cls(4)
 pset(0,0,peek(0x5002))
end
