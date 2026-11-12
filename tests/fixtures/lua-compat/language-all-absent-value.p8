pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function no_values() end
function _init()
 local count=0
 for value in all(no_values()) do count+=1 end
 for value in all(split(nil)) do count+=10 end
 for value in all(nil) do count+=100 end
 poke(0x5000,count==0 and 1 or 0,type(all())=="function" and 1 or 0)
end
function _update() end
function _draw() end
