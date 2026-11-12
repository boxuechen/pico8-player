pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 srand(1)
 local value=rnd("ffff.ffff")
 local member=rnd({11,22,33})
 poke(0x5000,type(value)=="number" and 1 or 0,(member==11 or member==22 or member==33) and 1 or 0)
end
function _update() end
function _draw() end
