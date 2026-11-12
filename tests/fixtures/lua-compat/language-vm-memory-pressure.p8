pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 local values={}
 for i=1,12000 do values[i]={i,i+1} end
 poke(0x5000,#values==12000 and 1 or 0)
 values=nil
end
function _update() end
function _draw() end
