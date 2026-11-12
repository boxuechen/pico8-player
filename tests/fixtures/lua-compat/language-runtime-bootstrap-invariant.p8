pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
local bootstrap={}
for i=1,2000 do bootstrap[i]={i} end
function _init()
 poke(0x5000,#bootstrap==2000 and 1 or 0)
end
function _update() end
function _draw() end
