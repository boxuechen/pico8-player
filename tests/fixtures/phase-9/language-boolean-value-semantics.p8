pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 local mask=btnp()
 local platform=stat(102)
 local numeric=stat(8)+stat(26)+stat(56)+stat(90)+stat(95)
 print(stat(120))
 local audio=type(stat(19))=="number" and type(stat(21))=="number"
 poke(0x5000,mask>0 and 1 or 0,#platform>0 and 1 or 0,type(numeric)=="number" and 1 or 0,audio and 1 or 0)
end
function _update() end
function _draw() end
