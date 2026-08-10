pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 local a,b,c=1,2,3
 if (a==1) b,c=c,b
 local total=a+b+c+stat(56)
 poke(0x5000,type(total)=="number" and 1 or 0)
end
function _update() end
function _draw() end
