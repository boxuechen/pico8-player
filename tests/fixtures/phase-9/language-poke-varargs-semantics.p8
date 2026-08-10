pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 poke(0x5000)
 poke(0x5000,nil,7)
 local values={}
 for i=1,9000 do values[i]=i end
 poke(0x8000,unpack(values))
 poke(0x5002,peek(0x8000),peek(0xa327))
end
function _update() end
function _draw() end
